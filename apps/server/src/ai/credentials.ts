import { createHash, hkdfSync, randomBytes } from "node:crypto";

import { AI_KEY_VARIABLES, AI_PROXY_PATH } from "@chopin/protocol/ai-credentials";

import { decrypted, encrypted, imported } from "../auth/session";

import type {
	AiCredentialSummary,
	AiProvider,
	AiProviderGrant,
	ConnectAiCredential,
	CopilotAccess,
} from "@chopin/protocol/ai-credentials";
import type { AiCredentialRecord, AiPlaceholder } from "../storage/model";
import type { StorageAdapter } from "../storage/port";

const CREDENTIAL_CONTEXT = "chopin:ai-credential:v1";
const PLACEHOLDER_PREFIX = "chopin_ai_";
const PLACEHOLDER = /^chopin_ai_[A-Za-z0-9_-]{43}$/;
/** A key as providers issue them: printable, without spaces, so it can only ever be a header value. */
const SECRET = /^[\x21-\x7e]{8,4096}$/;
/** How long an answer about a person's Copilot access is used before GitHub is asked again. */
const ACCESS_KNOWN_MS = 5 * 60 * 1000;

type Clock = () => Date;

/** Why a connection was refused, said to the person who asked. */
export class AiCredentialError extends Error {
	override name = "AiCredentialError";
}

/** Why the proxy refused a request, as it tells the agent that sent it. */
export type AiRefusal =
	| "no-placeholder"
	| "unknown-placeholder"
	| "other-provider"
	| "launch-ended"
	| "not-connected"
	| "sign-in-unavailable"
	| "no-copilot-access";

export type AiAuthorized = { placeholder: AiPlaceholder; secret: string };

export type AiLaunch = {
	userId: string;
	/** The paired machine the launch runs on; revoking it ends the launch. */
	machineId?: string;
	/** The document the launch works on; archiving or deleting it ends the launch. */
	channelId?: string;
	expiresAt: Date;
};

export type AiCredentialsOptions = {
	storage: StorageAdapter;
	/** The deployment's SESSION_ENCRYPTION_KEY, from which this store's own key is derived. */
	key: Uint8Array;
	/** Chopin's origin, where each provider's base URL points. */
	origin: string;
	clock?: Clock;
	/**
	 * The current GitHub token of the person a launch runs for, which Chopin renews; undefined when
	 * Chopin holds no live sign-in of theirs to read it from.
	 */
	githubToken: (launch: Pick<AiPlaceholder, "userId" | "machineId">) => Promise<string | undefined>;
	/**
	 * Whether a GitHub token's account has Copilot access: false when GitHub refuses it a Copilot
	 * token; throws when GitHub can't say. Without it, access is unknown and never refused.
	 */
	copilotEntitlement?: (githubToken: string) => Promise<boolean>;
};

function digest(value: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(value).digest());
}

function aad(userId: string, provider: AiProvider) {
	return `${CREDENTIAL_CONTEXT}:${userId}:${provider}`;
}

function summary(record: AiCredentialRecord, copilotAccess?: CopilotAccess): AiCredentialSummary {
	return {
		provider: record.provider,
		kind: record.kind,
		updatedAt: record.updatedAt.toISOString(),
		...(record.kind === "github-sign-in" && copilotAccess ? { copilotAccess } : {}),
	};
}

/** Chopin's base URL for a provider's API, which its proxy route serves. */
export function aiBaseUrl(origin: string, provider: AiProvider): string {
	return `${origin}${AI_PROXY_PATH}/${provider}${provider === "openai" ? "/v1" : ""}`;
}

/**
 * The AI credentials people connect in Chopin, and the placeholders launches hold instead. A key
 * is kept encrypted under a key derived from SESSION_ENCRYPTION_KEY and is read only to answer a
 * proxied request; nothing returns it. A launch is handed a random placeholder per provider its
 * person connected, stored only as a digest, and each stands for that person's credential until
 * the launch ends, its machine is revoked or its document is archived.
 */
export class AiCredentials {
	readonly #storage: StorageAdapter;
	readonly #key: Promise<CryptoKey>;
	readonly #origin: string;
	readonly #clock: Clock;
	readonly #githubToken: AiCredentialsOptions["githubToken"];
	readonly #entitlement: AiCredentialsOptions["copilotEntitlement"];
	readonly #access = new Map<string, { access: boolean; at: number }>();

	constructor(options: AiCredentialsOptions) {
		this.#storage = options.storage;
		this.#key = imported(
			new Uint8Array(hkdfSync("sha256", options.key, "", CREDENTIAL_CONTEXT, 32)),
		);
		this.#origin = options.origin;
		this.#clock = options.clock ?? (() => new Date());
		this.#githubToken = options.githubToken;
		this.#entitlement = options.copilotEntitlement;
	}

	/**
	 * A person's connected providers, never a secret. A GitHub sign-in says whether it has Copilot
	 * access, asked with `githubToken`, their own sign-in's current token.
	 */
	async list(userId: string, githubToken?: string): Promise<AiCredentialSummary[]> {
		let records = await this.#storage.aiCredentials.list(userId);
		return Promise.all(records.map(async record =>
			summary(
				record,
				record.kind === "github-sign-in"
					? await this.#copilotAccess(userId, githubToken)
					: undefined,
			)
		));
	}

	/** Asks GitHub again whether a connected GitHub sign-in has Copilot access, as Check again does. */
	async check(userId: string, githubToken: string): Promise<AiCredentialSummary | undefined> {
		let record = await this.#storage.aiCredentials.get(userId, "github-copilot");
		if (!record) return undefined;
		return summary(
			record,
			record.kind === "github-sign-in"
				? await this.#copilotAccess(userId, githubToken, true)
				: undefined,
		);
	}

	/**
	 * Whether a person's GitHub sign-in has Copilot access: GitHub's answer for `githubToken`,
	 * remembered for a few minutes unless `fresh`. A refusal is `none`, not an error; a question
	 * GitHub couldn't answer is `unknown` and leaves nothing remembered.
	 */
	async #copilotAccess(
		userId: string,
		githubToken: string | undefined,
		fresh = false,
	): Promise<CopilotAccess> {
		let known = this.#access.get(userId);
		let now = this.#clock().getTime();
		if (!fresh && known && now - known.at < ACCESS_KNOWN_MS) {
			return known.access ? "access" : "none";
		}
		if (!githubToken || !this.#entitlement) return "unknown";
		try {
			let access = await this.#entitlement(githubToken);
			this.#access.set(userId, { access, at: now });
			return access ? "access" : "none";
		} catch {
			return "unknown";
		}
	}

	/** Connects `provider` for `userId`, replacing what they connected for it before. */
	async connect(
		userId: string,
		provider: AiProvider,
		input: ConnectAiCredential,
		githubToken?: string,
	): Promise<AiCredentialSummary> {
		let updatedAt = this.#clock();
		let record: AiCredentialRecord;
		if (input.kind === "github-sign-in") {
			if (provider !== "github-copilot") {
				throw new AiCredentialError("Only GitHub Copilot can use your GitHub sign-in.");
			}
			record = { userId, provider, kind: "github-sign-in", updatedAt };
		} else {
			let secret = input.secret.trim();
			if (!SECRET.test(secret)) {
				throw new AiCredentialError(
					"A key is 8 to 4096 printable characters, with no spaces.",
				);
			}
			record = {
				userId,
				provider,
				kind: "api-key",
				ciphertext: await encrypted(await this.#key, aad(userId, provider), { secret }),
				updatedAt,
			};
		}
		await this.#storage.aiCredentials.put(record);
		return summary(
			record,
			record.kind === "github-sign-in"
				? await this.#copilotAccess(userId, githubToken, true)
				: undefined,
		);
	}

	disconnect(userId: string, provider: AiProvider): Promise<boolean> {
		return this.#storage.aiCredentials.delete(userId, provider);
	}

	/**
	 * Placeholders for one launch, one per provider its person can use, stored before they are
	 * returned: each provider they connected, but GitHub Copilot through a GitHub sign-in GitHub
	 * says has no Copilot access. A person with nothing usable gets none, and no placeholder that
	 * would only fail.
	 */
	async launch(input: AiLaunch): Promise<{ launchId: string; grants: AiProviderGrant[] }> {
		let launchId = crypto.randomUUID();
		let connected = await this.#storage.aiCredentials.list(input.userId);
		let usable: AiCredentialRecord[] = [];
		for (let record of connected) {
			if (record.kind === "github-sign-in" && await this.#signInAccess(input) === "none") continue;
			usable.push(record);
		}
		let grants: AiProviderGrant[] = usable.map(record => ({
			provider: record.provider,
			baseUrl: aiBaseUrl(this.#origin, record.provider),
			placeholder: PLACEHOLDER_PREFIX + randomBytes(32).toString("base64url"),
			keyVariable: AI_KEY_VARIABLES[record.provider],
		}));
		if (grants.length) {
			await this.#storage.aiPlaceholders.put(grants.map(grant => ({
				digest: digest(grant.placeholder),
				launchId,
				userId: input.userId,
				provider: grant.provider,
				...(input.machineId ? { machineId: input.machineId } : {}),
				...(input.channelId ? { channelId: input.channelId } : {}),
				expiresAt: input.expiresAt,
			})));
		}
		return { launchId, grants };
	}

	async #signInAccess(launch: Pick<AiPlaceholder, "userId" | "machineId">) {
		return this.#copilotAccess(
			launch.userId,
			await this.#githubToken(launch).catch(() => undefined),
		);
	}

	/** Ends a launch: its placeholders stop working at once. */
	async end(launchId: string): Promise<void> {
		await this.#storage.aiPlaceholders.deleteLaunch(launchId);
	}

	/** Ends every launch on a machine, as revoking it does. */
	async machineEnded(machineId: string): Promise<void> {
		await this.#storage.aiPlaceholders.deleteForMachine(machineId);
	}

	sweep(): Promise<number> {
		return this.#storage.aiPlaceholders.deleteExpired(this.#clock());
	}

	/**
	 * The real credential `placeholder` stands for on `provider`'s route, or why there is none: it
	 * must be a live launch's, for that provider, on a machine not revoked and a document not
	 * archived, and its person must still have the provider connected.
	 */
	async authorize(
		placeholder: string | undefined,
		provider: AiProvider,
	): Promise<AiAuthorized | { refused: AiRefusal }> {
		if (!placeholder) return { refused: "no-placeholder" };
		if (!PLACEHOLDER.test(placeholder)) return { refused: "unknown-placeholder" };
		let now = this.#clock();
		let found = await this.#storage.aiPlaceholders.find(digest(placeholder), now);
		if (!found) return { refused: "unknown-placeholder" };
		if (found.provider !== provider) return { refused: "other-provider" };
		if (found.machineId) {
			let machine = await this.#storage.machines.get(found.machineId);
			if (!machine || machine.revokedAt) return { refused: "launch-ended" };
		}
		if (found.channelId) {
			let channel = await this.#storage.channels.get(found.channelId);
			if (!channel || channel.archivedAt) return { refused: "launch-ended" };
		}
		let record = await this.#storage.aiCredentials.get(found.userId, provider);
		if (!record) return { refused: "not-connected" };
		if (record.kind === "github-sign-in") {
			let token = await this.#githubToken(found);
			if (!token) return { refused: "sign-in-unavailable" };
			if (await this.#copilotAccess(found.userId, token) === "none") {
				return { refused: "no-copilot-access" };
			}
			return { placeholder: found, secret: token };
		}
		if (!record.ciphertext) return { refused: "not-connected" };
		let opened = await decrypted(await this.#key, aad(found.userId, provider), record.ciphertext);
		let secret = (opened as { secret?: unknown }).secret;
		return typeof secret === "string" && secret
			? { placeholder: found, secret }
			: { refused: "not-connected" };
	}
}
