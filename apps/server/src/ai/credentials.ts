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
import type { CopilotToken, CopilotTokenExchange } from "./copilot";
import type { StorageAdapter } from "../storage/port";

const CREDENTIAL_CONTEXT = "chopin:ai-credential:v1";
const PLACEHOLDER_PREFIX = "chopin_ai_";
const PLACEHOLDER = /^chopin_ai_[A-Za-z0-9_-]{43}$/;
/** A key as providers issue them: printable, without spaces, so it can only ever be a header value. */
const SECRET = /^[\x21-\x7e]{8,4096}$/;
/** How long GitHub's answer about a GitHub token's Copilot access, and its Copilot token, is used. */
const ACCESS_KNOWN_MS = 5 * 60 * 1000;
/** How long before a Copilot token expires that Chopin asks GitHub for the next one. */
const RENEW_BEFORE_MS = 60 * 1000;

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
	| "no-copilot-access"
	| "copilot-unavailable";

/**
 * The credential a placeholder stands for now: `secret` goes in the provider's credential header,
 * and `origin` (for Copilot, the account's own model host) replaces the provider's default origin.
 */
export type AiAuthorized = { placeholder: AiPlaceholder; secret: string; origin?: string };

/**
 * A provider its person connected that a launch was not given, and why: their GitHub sign-in
 * can't be read now, GitHub refused a Copilot token (no Copilot access), or GitHub couldn't be
 * asked (`copilot-unavailable`, which a later launch may not meet).
 */
export type AiWithheld = {
	provider: AiProvider;
	reason: "sign-in-unavailable" | "not-connected" | "no-copilot-access" | "copilot-unavailable";
};

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
	/** Exchanges a GitHub token for the Copilot token Copilot's model API takes. */
	copilotToken: CopilotTokenExchange;
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
		...(record.provider === "github-copilot" && copilotAccess ? { copilotAccess } : {}),
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
 * person can use, stored only as a digest, and each stands for that person's credential until
 * the launch ends, its machine is revoked or its document is archived. GitHub Copilot is reached
 * with the Copilot token GitHub exchanges the person's GitHub token for, which Chopin holds and
 * renews; neither token leaves the server.
 */
export class AiCredentials {
	readonly #storage: StorageAdapter;
	readonly #key: Promise<CryptoKey>;
	readonly #origin: string;
	readonly #clock: Clock;
	readonly #githubToken: AiCredentialsOptions["githubToken"];
	readonly #exchange: CopilotTokenExchange;
	readonly #copilotTokens = new Map<
		string,
		{ answer: Promise<CopilotToken | undefined>; until: number }
	>();

	constructor(options: AiCredentialsOptions) {
		this.#storage = options.storage;
		this.#key = imported(
			new Uint8Array(hkdfSync("sha256", options.key, "", CREDENTIAL_CONTEXT, 32)),
		);
		this.#origin = options.origin;
		this.#clock = options.clock ?? (() => new Date());
		this.#githubToken = options.githubToken;
		this.#exchange = options.copilotToken;
	}

	/**
	 * A person's connected providers, never a secret. GitHub Copilot says whether it has Copilot
	 * access, asked with the token it was connected with, or for a GitHub sign-in `githubToken`,
	 * their own sign-in's current token. The answer may be a few minutes old.
	 */
	async list(userId: string, githubToken?: string): Promise<AiCredentialSummary[]> {
		let records = await this.#storage.aiCredentials.list(userId);
		return Promise.all(records.map(async record =>
			summary(
				record,
				record.provider === "github-copilot"
					? await this.#copilotAccess(await this.#connectedToken(record, githubToken))
					: undefined,
			)
		));
	}

	/** Asks GitHub again whether a connected GitHub Copilot has Copilot access, as Check again does. */
	async check(userId: string, githubToken: string): Promise<AiCredentialSummary | undefined> {
		let record = await this.#storage.aiCredentials.get(userId, "github-copilot");
		if (!record) return undefined;
		return summary(
			record,
			await this.#copilotAccess(await this.#connectedToken(record, githubToken), true),
		);
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
			provider === "github-copilot"
				? await this.#copilotAccess(await this.#connectedToken(record, githubToken), true)
				: undefined,
		);
	}

	disconnect(userId: string, provider: AiProvider): Promise<boolean> {
		return this.#storage.aiCredentials.delete(userId, provider);
	}

	/**
	 * Placeholders for one launch, one per provider its person can use now, stored before they are
	 * returned. GitHub Copilot is given only when GitHub gives the person's GitHub token a Copilot
	 * token at this launch; otherwise it is `withheld`, with the reason. A provider disconnected
	 * while the launch was being prepared is not given either. With no grants nothing is stored, and
	 * the caller starts no runner.
	 */
	async launch(
		input: AiLaunch,
	): Promise<{ launchId: string; grants: AiProviderGrant[]; withheld: AiWithheld[] }> {
		let launchId = crypto.randomUUID();
		let connected = await this.#storage.aiCredentials.list(input.userId);
		let usable: AiCredentialRecord[] = [];
		let withheld: AiWithheld[] = [];
		for (let record of connected) {
			if (record.provider === "github-copilot") {
				let token = await this.#launchToken(record, input);
				if (!token) {
					withheld.push({
						provider: record.provider,
						reason: record.kind === "github-sign-in" ? "sign-in-unavailable" : "not-connected",
					});
					continue;
				}
				let access = await this.#copilotAccess(token, true);
				if (access !== "access") {
					withheld.push({
						provider: record.provider,
						reason: access === "none" ? "no-copilot-access" : "copilot-unavailable",
					});
					continue;
				}
			}
			usable.push(record);
		}
		let grants: AiProviderGrant[] = usable.map(record => ({
			provider: record.provider,
			baseUrl: aiBaseUrl(this.#origin, record.provider),
			placeholder: PLACEHOLDER_PREFIX + randomBytes(32).toString("base64url"),
			keyVariable: AI_KEY_VARIABLES[record.provider],
		}));
		if (!grants.length) return { launchId, grants, withheld };
		await this.#storage.aiPlaceholders.put(this.#rows(launchId, input, grants));
		let still = new Set(
			(await this.#storage.aiCredentials.list(input.userId)).map(record => record.provider),
		);
		let kept = grants.filter(grant => still.has(grant.provider));
		if (kept.length !== grants.length) {
			await this.#storage.aiPlaceholders.deleteLaunch(launchId);
			if (kept.length) await this.#storage.aiPlaceholders.put(this.#rows(launchId, input, kept));
		}
		return { launchId, grants: kept, withheld };
	}

	#rows(launchId: string, input: AiLaunch, grants: AiProviderGrant[]): AiPlaceholder[] {
		return grants.map(grant => ({
			digest: digest(grant.placeholder),
			launchId,
			userId: input.userId,
			provider: grant.provider,
			...(input.machineId ? { machineId: input.machineId } : {}),
			...(input.channelId ? { channelId: input.channelId } : {}),
			expiresAt: input.expiresAt,
		}));
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
	 * archived, and its person must still have the provider connected. For GitHub Copilot it is the
	 * Copilot token GitHub gives the person's GitHub token, renewed before it expires.
	 */
	async authorize(
		placeholder: string | undefined,
		provider: AiProvider,
	): Promise<AiAuthorized | { refused: AiRefusal }> {
		if (!placeholder) return { refused: "no-placeholder" };
		if (!PLACEHOLDER.test(placeholder)) return { refused: "unknown-placeholder" };
		let found = await this.#storage.aiPlaceholders.find(digest(placeholder), this.#clock());
		if (!found) return { refused: "unknown-placeholder" };
		if (found.provider !== provider) return { refused: "other-provider" };
		if (!await this.#launchLive(found)) return { refused: "launch-ended" };
		let record = await this.#storage.aiCredentials.get(found.userId, provider);
		if (!record) return { refused: "not-connected" };
		if (provider === "github-copilot") {
			let token = await this.#launchToken(record, found);
			if (!token) {
				return {
					refused: record.kind === "github-sign-in" ? "sign-in-unavailable" : "not-connected",
				};
			}
			let copilot: CopilotToken | undefined;
			try {
				copilot = await this.#copilotToken(token);
			} catch {
				return { refused: "copilot-unavailable" };
			}
			if (!copilot) return { refused: "no-copilot-access" };
			return {
				placeholder: found,
				secret: copilot.token,
				...(copilot.api ? { origin: copilot.api } : {}),
			};
		}
		let secret = await this.#secret(record);
		return secret ? { placeholder: found, secret } : { refused: "not-connected" };
	}

	/**
	 * Whether an authorized placeholder still stands for a credential, asked again just before the
	 * proxy sends a request: its launch has not ended or expired, its machine is not revoked, its
	 * document is not archived, and its person still has the provider connected.
	 */
	async current(placeholder: AiPlaceholder): Promise<boolean> {
		let found = await this.#storage.aiPlaceholders.find(placeholder.digest, this.#clock());
		if (!found || found.launchId !== placeholder.launchId) return false;
		if (!await this.#launchLive(found)) return false;
		return !!await this.#storage.aiCredentials.get(found.userId, found.provider);
	}

	async #launchLive(placeholder: AiPlaceholder): Promise<boolean> {
		if (placeholder.machineId) {
			let machine = await this.#storage.machines.get(placeholder.machineId);
			if (!machine || machine.revokedAt) return false;
		}
		if (placeholder.channelId) {
			let channel = await this.#storage.channels.get(placeholder.channelId);
			if (!channel || channel.archivedAt) return false;
		}
		return true;
	}

	async #secret(record: AiCredentialRecord): Promise<string | undefined> {
		if (!record.ciphertext) return undefined;
		try {
			let opened = await decrypted(
				await this.#key,
				aad(record.userId, record.provider),
				record.ciphertext,
			);
			let secret = (opened as { secret?: unknown }).secret;
			return typeof secret === "string" && secret ? secret : undefined;
		} catch {
			return undefined;
		}
	}

	/** The GitHub token a connected GitHub Copilot is used with: the one connected, or a sign-in's. */
	async #connectedToken(record: AiCredentialRecord, signIn: string | undefined) {
		return record.kind === "github-sign-in" ? signIn : this.#secret(record);
	}

	async #launchToken(
		record: AiCredentialRecord,
		launch: Pick<AiPlaceholder, "userId" | "machineId">,
	): Promise<string | undefined> {
		if (record.kind !== "github-sign-in") return this.#secret(record);
		return this.#githubToken(launch).catch(() => undefined);
	}

	/**
	 * Whether a GitHub token's account has Copilot access, from GitHub's answer to exchanging it,
	 * which is used for a few minutes unless `fresh`. A refusal is `none`, not an error; a token
	 * Chopin can't read, or a question GitHub couldn't answer, is `unknown`.
	 */
	async #copilotAccess(githubToken: string | undefined, fresh = false): Promise<CopilotAccess> {
		if (!githubToken) return "unknown";
		try {
			return await this.#copilotToken(githubToken, fresh) ? "access" : "none";
		} catch {
			return "unknown";
		}
	}

	/**
	 * The Copilot token GitHub gives `githubToken`, asked once for every caller at a time and held
	 * until a minute before it expires, or five minutes at most, so a seat GitHub removes is noticed.
	 * A refusal is held as long; a failure is not held.
	 */
	async #copilotToken(githubToken: string, fresh = false): Promise<CopilotToken | undefined> {
		let key = Buffer.from(digest(githubToken)).toString("hex");
		let now = this.#clock().getTime();
		let held = this.#copilotTokens.get(key);
		if (!fresh && held && now < held.until) return held.answer;
		for (let [other, entry] of this.#copilotTokens) {
			if (entry.until <= now) this.#copilotTokens.delete(other);
		}
		let entry = { answer: this.#exchange(githubToken), until: now + ACCESS_KNOWN_MS };
		this.#copilotTokens.set(key, entry);
		try {
			let token = await entry.answer;
			if (token) entry.until = Math.min(entry.until, token.expiresAt - RENEW_BEFORE_MS);
			return token;
		} catch (error) {
			if (this.#copilotTokens.get(key) === entry) this.#copilotTokens.delete(key);
			throw error;
		}
	}
}
