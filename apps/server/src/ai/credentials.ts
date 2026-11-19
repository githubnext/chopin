import { createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import { AI_KEY_VARIABLES, AI_PROXY_PATH } from "@chopin/protocol/ai-credentials";

import { decrypted, encrypted, imported } from "../auth/session";
import { AI_UPSTREAMS } from "./proxy";

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
const LAUNCH_PREFIX = "chopin_launch_";
/** A key as providers issue them: printable, without spaces, so it can only ever be a header value. */
const SECRET = /^[\x21-\x7e]{8,4096}$/;
/** How long GitHub's answer about a GitHub token's Copilot access, and its Copilot token, is used. */
const ACCESS_KNOWN_MS = 5 * 60 * 1000;
/** How long before a Copilot token expires that Chopin asks GitHub for the next one. */
const RENEW_BEFORE_MS = 60 * 1000;
/** How many of a key's last characters the list shows, to tell keys apart. */
const SUFFIX_LENGTH = 4;
/** The list says when a credential was last used to the minute, so one use a minute is saved. */
const USE_MINUTE_MS = 60 * 1000;
/** How many times a launch is prepared again when its person's credentials change meanwhile. */
const LAUNCH_ATTEMPTS = 3;
/** How many times the final handoff reads again when a cutoff completes while it reads. */
const HANDOFF_ATTEMPTS = 3;

type Clock = () => Date;

/** Why a connection was refused, said to the person who asked, with the status that says it. */
export class AiCredentialError extends Error {
	override name = "AiCredentialError";
	constructor(message: string, readonly status = 422) {
		super(message);
	}
}

/** How each provider whose key Chopin checks before saving it is named to the person. */
const CHECKED: Partial<Record<AiProvider, string>> = { openai: "OpenAI", anthropic: "Anthropic" };

/** Why the proxy refused a request, as it tells the agent that sent it. */
export type AiRefusal =
	| "no-placeholder"
	| "no-launch"
	| "unknown-placeholder"
	| "other-provider"
	| "other-launch"
	| "launch-ended"
	| "not-connected"
	| "credential-changed"
	| "sign-in-unavailable"
	| "no-copilot-access"
	| "copilot-unavailable"
	| "busy";

/**
 * The credential a placeholder stands for now: `secret` goes in the provider's credential header,
 * and `origin` (for Copilot, the account's own model host) replaces the provider's default origin.
 * `record` is the person's credential as it was read, which must still be theirs, unchanged, when
 * the request is sent. A Copilot token is good until `expiresAt` (milliseconds since the epoch) and
 * never after.
 */
export type AiAuthorized = {
	placeholder: AiPlaceholder;
	record: AiCredentialRecord;
	secret: string;
	origin?: string;
	expiresAt?: number;
};

/** What a launch is handed: `launchToken` stays with its runner, `grants` go to its agent. */
export type AiLaunchGrants = {
	launchId: string;
	/** The launch's own credential, sent by its runner in `AI_LAUNCH_HEADER`; never its agent's. */
	launchToken: string;
	grants: AiProviderGrant[];
	withheld: AiWithheld[];
};

/** GitHub gave a Copilot token that had already expired by the time Chopin had it. */
class CopilotTokenExpired extends Error {
	override name = "CopilotTokenExpired";
}

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
	/** Each provider's origin a key is checked at before it is saved; tests point them at fakes. */
	upstreams?: Partial<Record<AiProvider, string>>;
	fetch?: typeof fetch;
};

function digest(value: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(value).digest());
}

function aad(userId: string, provider: AiProvider) {
	return `${CREDENTIAL_CONTEXT}:${userId}:${provider}`;
}

/**
 * Whether `current` is still the credential `read` was: the same person, provider and kind,
 * connected at the same time, and for a key the same ciphertext, which every connect makes anew
 * with a fresh nonce, so a key replaced, or removed and added again, is never the same.
 */
function unchanged(read: AiCredentialRecord, current: AiCredentialRecord | undefined): boolean {
	return current !== undefined
		&& current.userId === read.userId
		&& current.provider === read.provider
		&& current.kind === read.kind
		&& current.updatedAt.getTime() === read.updatedAt.getTime()
		&& (current.ciphertext && read.ciphertext
			? Buffer.from(current.ciphertext).equals(read.ciphertext)
			: !current.ciphertext && !read.ciphertext);
}

/** Whether a Copilot token's deadline has come at `now`; a key has none. */
function expired(authorized: AiAuthorized, now: Date): boolean {
	return authorized.expiresAt !== undefined && now.getTime() >= authorized.expiresAt;
}

/** Whether `current` is the very set of credentials `read` was, provider by provider. */
function sameSet(read: AiCredentialRecord[], current: AiCredentialRecord[]): boolean {
	return read.length === current.length
		&& read.every(record =>
			unchanged(record, current.find(now => now.provider === record.provider))
		);
}

function summary(record: AiCredentialRecord, copilotAccess?: CopilotAccess): AiCredentialSummary {
	return {
		provider: record.provider,
		kind: record.kind,
		...(record.updatedAt.getTime() ? { updatedAt: record.updatedAt.toISOString() } : {}),
		...(record.suffix ? { suffix: record.suffix } : {}),
		...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt.toISOString() } : {}),
		...(record.provider === "github-copilot" && copilotAccess ? { copilotAccess } : {}),
	};
}

/**
 * GitHub Copilot through the person's GitHub sign-in, which is theirs without connecting it while
 * no row for it is saved (no token they connected instead); it was never connected, so its time is
 * the epoch, which the list leaves out.
 */
function signIn(userId: string): AiCredentialRecord {
	return { userId, provider: "github-copilot", kind: "github-sign-in", updatedAt: new Date(0) };
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
	readonly #upstreams: Partial<Record<AiProvider, string>>;
	readonly #fetch: typeof fetch;
	readonly #copilotTokens = new Map<
		string,
		{ answer: Promise<CopilotToken | undefined>; until: number; asked: number }
	>();
	/** How many times GitHub was asked for a Copilot token, numbering each question in order. */
	#asked = 0;
	/**
	 * The latest answer GitHub gave about each person's Copilot access, by the order it was asked
	 * in: a newer question's answer replaces an older one's, whichever arrived first.
	 */
	readonly #entitlements = new Map<string, { asked: number; access: "access" | "none" }>();

	constructor(options: AiCredentialsOptions) {
		this.#storage = options.storage;
		this.#key = imported(
			new Uint8Array(hkdfSync("sha256", options.key, "", CREDENTIAL_CONTEXT, 32)),
		);
		this.#origin = options.origin;
		this.#clock = options.clock ?? (() => new Date());
		this.#githubToken = options.githubToken;
		this.#exchange = options.copilotToken;
		this.#upstreams = options.upstreams ?? {};
		this.#fetch = options.fetch ?? fetch;
	}

	/**
	 * A person's connected providers, never a secret, GitHub Copilot always among them. GitHub Copilot
	 * says whether it has Copilot access, asked with the token it was connected with, or for a GitHub
	 * sign-in `githubToken`, their own sign-in's current token. The answer may be a few minutes old.
	 */
	async list(userId: string, githubToken?: string): Promise<AiCredentialSummary[]> {
		let records = await this.#connected(userId);
		return Promise.all(records.map(async record =>
			summary(
				record,
				record.provider === "github-copilot"
					? (await this.#copilotAccess(userId, await this.#connectedToken(record, githubToken)))
						.access
					: undefined,
			)
		));
	}

	/** Asks GitHub again whether the person's GitHub Copilot has Copilot access, as Check again does. */
	async check(userId: string, githubToken: string): Promise<AiCredentialSummary> {
		let record = await this.#storage.aiCredentials.get(userId, "github-copilot") ?? signIn(userId);
		return summary(
			record,
			(await this.#copilotAccess(userId, await this.#connectedToken(record, githubToken), true))
				.access,
		);
	}

	/**
	 * Connects `provider` for `userId`, replacing what they connected for it before. An OpenAI or
	 * Anthropic key is first checked with one request to that provider, and saved only when it is
	 * accepted, so a refused key never replaces one that works.
	 */
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
			await this.#checkKey(provider, secret);
			record = {
				userId,
				provider,
				kind: "api-key",
				ciphertext: await encrypted(await this.#key, aad(userId, provider), { secret }),
				suffix: secret.slice(-SUFFIX_LENGTH),
				updatedAt,
			};
		}
		await this.#storage.aiCredentials.put(record);
		return summary(
			record,
			provider === "github-copilot"
				? (await this.#copilotAccess(userId, await this.#connectedToken(record, githubToken), true))
					.access
				: undefined,
		);
	}

	disconnect(userId: string, provider: AiProvider): Promise<boolean> {
		return this.#storage.aiCredentials.delete(userId, provider);
	}

	/**
	 * Asks the provider, once, to list its models with `secret`, and throws unless it answers: a
	 * refusal (401 or 403) says the key is wrong, anything else that the key couldn't be checked.
	 */
	async #checkKey(provider: AiProvider, secret: string): Promise<void> {
		let name = CHECKED[provider];
		if (!name) return;
		let headers: Record<string, string> = provider === "anthropic"
			? { "x-api-key": secret, "anthropic-version": "2023-06-01" }
			: { authorization: `Bearer ${secret}` };
		let status: number | undefined;
		try {
			let answer = await this.#fetch(
				`${this.#upstreams[provider] ?? AI_UPSTREAMS[provider]}/v1/models`,
				{ headers, redirect: "manual", signal: AbortSignal.timeout(10_000) },
			);
			status = answer.status;
			await answer.body?.cancel();
		} catch {
			status = undefined;
		}
		if (status !== undefined && status >= 200 && status < 300) return;
		if (status === 401 || status === 403) {
			throw new AiCredentialError(`${name} refused this key. Check it and try again.`);
		}
		throw new AiCredentialError(
			`Chopin couldn't check this key with ${name} now. Try again in a moment.`,
			502,
		);
	}

	/**
	 * Placeholders for one launch, one per provider its person can use now, stored before they are
	 * returned. GitHub Copilot is given only when GitHub gives the person's GitHub token a Copilot
	 * token at this launch; otherwise it is `withheld`, with the reason. Once they are stored, the
	 * person's credentials are read a final time, and the grants are published (none included) in
	 * the same step as the last check, with nothing awaited between, only while all of it holds:
	 * that read found the very credentials the launch was prepared with, none was connected, replaced
	 * or removed since it began, no answer about Copilot asked after the launch's own (a Check again)
	 * says otherwise, and the launch has not reached its deadline. A launch past its deadline takes
	 * its placeholders back and is given nothing; any other change takes them back and prepares the
	 * launch afresh, keys and all, at most `LAUNCH_ATTEMPTS` times. So no grant is returned for a
	 * credential that changed before it was, nor without one that was added. With no grants nothing
	 * is stored, and the caller starts no runner.
	 */
	async launch(input: AiLaunch): Promise<AiLaunchGrants> {
		let launchId = crypto.randomUUID();
		let launchToken = LAUNCH_PREFIX + randomBytes(32).toString("base64url");
		let launchDigest = digest(launchToken);
		let withheld: AiWithheld[] = [];
		for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt++) {
			let admitted = await this.#admitted(input);
			withheld = admitted.withheld;
			let grants: AiProviderGrant[] = admitted.usable.map(record => ({
				provider: record.provider,
				baseUrl: aiBaseUrl(this.#origin, record.provider),
				placeholder: PLACEHOLDER_PREFIX + randomBytes(32).toString("base64url"),
				keyVariable: AI_KEY_VARIABLES[record.provider],
			}));
			if (grants.length) {
				await this.#storage.aiPlaceholders.put(this.#rows(launchId, launchDigest, input, grants));
			}
			let version = this.#storage.aiCredentials.version(input.userId);
			let current = await this.#connected(input.userId);
			let latest = this.#entitlements.get(input.userId);
			let held = this.#storage.aiCredentials.version(input.userId) === version
				&& sameSet(admitted.connected, current)
				&& (!latest || latest.asked <= admitted.decided || latest.access === admitted.copilot);
			let due = this.#clock() >= input.expiresAt;
			if (held && !due) return { launchId, launchToken, grants, withheld };
			if (grants.length) await this.#storage.aiPlaceholders.deleteLaunch(launchId);
			if (due) break;
		}
		return { launchId, launchToken, grants: [], withheld };
	}

	/**
	 * The person's connected providers (`connected`), those a launch can be given now, and those it
	 * can't, with why. `copilot` is what GitHub answered about Copilot access at this launch, and
	 * `decided` the number of the question it answered, or, unanswered, of the latest answer there
	 * was before the launch asked.
	 */
	async #admitted(input: AiLaunch) {
		let decided = this.#entitlements.get(input.userId)?.asked ?? 0;
		let copilot: CopilotAccess | undefined;
		let connected = await this.#connected(input.userId);
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
				let answer = await this.#copilotAccess(input.userId, token, true);
				if (answer.asked !== undefined) {
					decided = answer.asked;
					copilot = answer.access;
				}
				if (answer.access !== "access") {
					withheld.push({
						provider: record.provider,
						reason: answer.access === "none" ? "no-copilot-access" : "copilot-unavailable",
					});
					continue;
				}
			}
			usable.push(record);
		}
		return { connected, usable, withheld, decided, copilot };
	}

	#rows(
		launchId: string,
		launchDigest: Uint8Array,
		input: AiLaunch,
		grants: AiProviderGrant[],
	): AiPlaceholder[] {
		return grants.map(grant => ({
			digest: digest(grant.placeholder),
			launchId,
			launchDigest,
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
	 * Calls `serve` for what a launch's runner reads for itself and is sent no credential for (the
	 * model catalog). The request must carry one of that launch's placeholders, of any provider, and
	 * the launch's own credential, and the launch must be live: unexpired, on a machine not revoked
	 * and a document not archived. The last check is made in the same step as `serve` is called,
	 * with nothing awaited between, and is read again when a cutoff completed while it was read, so
	 * a launch that ended before `serve` is never served.
	 */
	async forLaunch<T>(
		placeholder: string | undefined,
		launchToken: string | undefined,
		serve: () => T,
	): Promise<T | { refused: AiRefusal }> {
		if (!placeholder) return { refused: "no-placeholder" };
		if (!launchToken) return { refused: "no-launch" };
		if (!PLACEHOLDER.test(placeholder)) return { refused: "unknown-placeholder" };
		for (let attempt = 0; attempt < HANDOFF_ATTEMPTS; attempt++) {
			let cutoffs = this.#storage.aiPlaceholders.cutoffs();
			let found = await this.#storage.aiPlaceholders.find(digest(placeholder), this.#clock());
			if (!found) return { refused: "unknown-placeholder" };
			if (!timingSafeEqual(found.launchDigest, digest(launchToken))) {
				return { refused: "other-launch" };
			}
			if (!await this.#launchLive(found)) return { refused: "launch-ended" };
			if (this.#storage.aiPlaceholders.cutoffs() !== cutoffs) continue;
			if (this.#clock() >= found.expiresAt) return { refused: "launch-ended" };
			return serve();
		}
		return { refused: "busy" };
	}

	/**
	 * The real credential `placeholder` stands for on `provider`'s route, or why there is none. The
	 * request must come from the launch the placeholder was given to, proved by `launchToken`, the
	 * launch's own credential that its runner holds and its agent never sees, so a placeholder copied
	 * into another launch, the same person's or anyone else's, reaches nothing; this is checked
	 * before any credential is read. The launch must be live, for that provider, on a machine not
	 * revoked and a document not archived, and its person must still have the provider connected.
	 * For GitHub Copilot it is the Copilot token GitHub gives the person's GitHub token, renewed
	 * before it expires.
	 */
	async authorize(
		placeholder: string | undefined,
		provider: AiProvider,
		launchToken: string | undefined,
	): Promise<AiAuthorized | { refused: AiRefusal }> {
		if (!placeholder) return { refused: "no-placeholder" };
		if (!launchToken) return { refused: "no-launch" };
		if (!PLACEHOLDER.test(placeholder)) return { refused: "unknown-placeholder" };
		let found = await this.#storage.aiPlaceholders.find(digest(placeholder), this.#clock());
		if (!found) return { refused: "unknown-placeholder" };
		if (found.provider !== provider) return { refused: "other-provider" };
		if (!timingSafeEqual(found.launchDigest, digest(launchToken))) {
			return { refused: "other-launch" };
		}
		if (!await this.#launchLive(found)) return { refused: "launch-ended" };
		return this.#credential(found);
	}

	/**
	 * Sends a request with what the proxy may send now, decided at the final handoff once the
	 * request's body is read. A Copilot token that expired meanwhile is renewed first. Then the
	 * launch, its machine, its document and the person's credential are read again together, and
	 * `prepare` builds the whole request for that credential and returns its entry to the transport.
	 * Last, with nothing awaited between this check and that entry: when a cutoff (a launch ended, a
	 * machine revoked, a document archived, a credential connected or removed) completed while they
	 * were read, they are read again; the launch must not have reached its deadline; and a Copilot
	 * token whose deadline came meanwhile is renewed and the request prepared again. So a request is
	 * refused when its launch ended or expired, its machine was revoked or its document archived
	 * (`launch-ended`), when its person disconnected the provider (`not-connected`), or when the
	 * credential it was admitted with was replaced, or removed and connected again
	 * (`credential-changed`), whenever that completed before the send, and never carries an expired
	 * Copilot token. Cutoffs that keep completing while it reads refuse it as `busy`.
	 */
	async handoff<T>(
		authorized: AiAuthorized,
		prepare: (authorized: AiAuthorized) => () => T,
	): Promise<T | { refused: AiRefusal }> {
		let current = authorized;
		for (let attempt = 0; attempt < HANDOFF_ATTEMPTS; attempt++) {
			if (expired(current, this.#clock())) {
				let renewed = await this.#credential(current.placeholder);
				if ("refused" in renewed) return renewed;
				current = renewed;
			}
			let placeholder = current.placeholder;
			let cutoffs = this.#storage.aiPlaceholders.cutoffs();
			let [found, live, record] = await Promise.all([
				this.#storage.aiPlaceholders.find(placeholder.digest, this.#clock()),
				this.#launchLive(placeholder),
				this.#record(placeholder.userId, placeholder.provider),
			]);
			if (!found || found.launchId !== placeholder.launchId || !live) {
				return { refused: "launch-ended" };
			}
			if (!record) return { refused: "not-connected" };
			if (!unchanged(authorized.record, record)) return { refused: "credential-changed" };
			let enter = prepare(current);
			if (this.#storage.aiPlaceholders.cutoffs() !== cutoffs) continue;
			let now = this.#clock();
			if (now >= found.expiresAt) return { refused: "launch-ended" };
			if (expired(current, now)) continue;
			let sent = enter();
			this.#used(record, now);
			return sent;
		}
		return { refused: "busy" };
	}

	/**
	 * Saves that `record` was sent at `now`, unless the use it was read with is in the same minute,
	 * which the list already shows, or later, which it must keep showing.
	 */
	#used(record: AiCredentialRecord, now: Date): void {
		let last = record.lastUsedAt?.getTime();
		if (
			last !== undefined
			&& (last >= now.getTime()
				|| Math.floor(last / USE_MINUTE_MS) === Math.floor(now.getTime() / USE_MINUTE_MS))
		) return;
		this.#storage.aiCredentials.used(record, now).catch(err =>
			console.warn("[ai] couldn't record when a credential was last used", err)
		);
	}

	async #credential(found: AiPlaceholder): Promise<AiAuthorized | { refused: AiRefusal }> {
		let record = await this.#record(found.userId, found.provider);
		if (!record) return { refused: "not-connected" };
		if (found.provider !== "github-copilot") {
			let secret = await this.#secret(record);
			return secret ? { placeholder: found, record, secret } : { refused: "not-connected" };
		}
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
			record,
			secret: copilot.token,
			expiresAt: copilot.expiresAt,
			...(copilot.api ? { origin: copilot.api } : {}),
		};
	}

	/** A person's saved provider rows, with GitHub Copilot through their sign-in when none is saved. */
	async #connected(userId: string): Promise<AiCredentialRecord[]> {
		let records = await this.#storage.aiCredentials.list(userId);
		return records.some(record => record.provider === "github-copilot")
			? records
			: [signIn(userId), ...records];
	}

	/** A person's credential for `provider`: the saved row, else for GitHub Copilot their sign-in. */
	async #record(userId: string, provider: AiProvider): Promise<AiCredentialRecord | undefined> {
		let record = await this.#storage.aiCredentials.get(userId, provider);
		return record ?? (provider === "github-copilot" ? signIn(userId) : undefined);
	}

	async #launchLive(placeholder: AiPlaceholder): Promise<boolean> {
		let [machine, channel] = await Promise.all([
			placeholder.machineId ? this.#storage.machines.get(placeholder.machineId) : undefined,
			placeholder.channelId ? this.#storage.channels.get(placeholder.channelId) : undefined,
		]);
		if (placeholder.machineId && (!machine || machine.revokedAt)) return false;
		if (placeholder.channelId && (!channel || channel.archivedAt)) return false;
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
	 * which is used for a few minutes unless `fresh`, with the number of the question it answered
	 * (`asked`), kept as `userId`'s latest answer unless one asked later is. A refusal is `none`, not
	 * an error; a token Chopin can't read, or a question GitHub couldn't answer, is `unknown`.
	 */
	async #copilotAccess(
		userId: string,
		githubToken: string | undefined,
		fresh = false,
	): Promise<{ access: CopilotAccess; asked?: number }> {
		if (!githubToken) return { access: "unknown" };
		let answer: { token: CopilotToken | undefined; asked: number };
		try {
			answer = await this.#copilotAnswer(githubToken, fresh);
		} catch {
			return { access: "unknown" };
		}
		let access = answer.token ? "access" as const : "none" as const;
		let latest = this.#entitlements.get(userId);
		if (!latest || latest.asked < answer.asked) {
			this.#entitlements.set(userId, { asked: answer.asked, access });
		}
		return { access, asked: answer.asked };
	}

	async #copilotToken(githubToken: string): Promise<CopilotToken | undefined> {
		return (await this.#copilotAnswer(githubToken)).token;
	}

	/**
	 * The Copilot token GitHub gives `githubToken`, asked once for every caller at a time and held
	 * until a minute before it expires, or five minutes at most, so a seat GitHub removes is noticed,
	 * with the number of the question it answers. A refusal is held as long; a failure is not held. A
	 * token that has expired by the time a caller has it, one GitHub gave already expired or one that
	 * expired while GitHub answered, is a failure: it is never returned.
	 */
	async #copilotAnswer(
		githubToken: string,
		fresh = false,
	): Promise<{ token: CopilotToken | undefined; asked: number }> {
		let key = Buffer.from(digest(githubToken)).toString("hex");
		let now = this.#clock().getTime();
		let held = this.#copilotTokens.get(key);
		let entry = !fresh && held && now < held.until ? held : this.#ask(key, githubToken, now);
		let token = await entry.answer;
		if (token && token.expiresAt <= this.#clock().getTime()) {
			if (this.#copilotTokens.get(key) === entry) this.#copilotTokens.delete(key);
			throw new CopilotTokenExpired();
		}
		return { token, asked: entry.asked };
	}

	#ask(key: string, githubToken: string, now: number) {
		for (let [other, entry] of this.#copilotTokens) {
			if (entry.until <= now) this.#copilotTokens.delete(other);
		}
		let entry = {
			answer: this.#exchange(githubToken),
			until: now + ACCESS_KNOWN_MS,
			asked: ++this.#asked,
		};
		this.#copilotTokens.set(key, entry);
		entry.answer.then(
			token => {
				if (token) entry.until = Math.min(entry.until, token.expiresAt - RENEW_BEFORE_MS);
			},
			() => {
				if (this.#copilotTokens.get(key) === entry) this.#copilotTokens.delete(key);
			},
		);
		return entry;
	}
}
