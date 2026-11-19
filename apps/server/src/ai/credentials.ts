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
import type { AiCredentialRecord, AiPlaceholder, Lease } from "../storage/model";
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
/** How many times GitHub is asked about an account whose answers keep crossing others' answers. */
const ANSWER_ATTEMPTS = 3;

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
	| "cancelled"
	| "restarting"
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

/**
 * The deadlines a send must come before, in milliseconds since the epoch: its launch's, and its
 * Copilot token's. The transport checks them on the clock reading it takes the send at.
 */
export type AiDeadlines = { launch: number; token?: number };

/**
 * What the transport did with a send: took it at `at` (milliseconds since the epoch, its clock's
 * reading as it took it), or found one of its deadlines come first.
 */
export type AiAdmitted<T> = { sent: T; at: number } | { late: "launch" | "token" };

/** GitHub gave a Copilot token that had already expired by the time Chopin had it. */
class CopilotTokenExpired extends Error {
	override name = "CopilotTokenExpired";
}

/**
 * What GitHub answered about the Copilot access of `account` (see `copilotAccount`), to a question
 * put once `since` answers had completed; `unknown`, with no account, when it couldn't be asked.
 */
type CopilotAnswer = { access: CopilotAccess; since: number; account?: string };

/**
 * GitHub's answer about one GitHub token, held for the next questions about it: the account it is
 * about, how many answers had completed when it was asked, and, once it has, what it answered.
 */
type HeldAnswer = {
	answer: Promise<CopilotToken | undefined>;
	until: number;
	account: string;
	since: number;
	access?: "access" | "none";
};

/**
 * Which account an answer about Copilot access is about: a person's own GitHub sign-in, whichever
 * of its tokens asked (a browser login's or a paired machine's), or a GitHub token they connected
 * instead, which may be anyone's.
 */
function copilotAccount(record: AiCredentialRecord, githubToken: string): string {
	return record.kind === "github-sign-in"
		? `sign-in:${record.userId}`
		: `token:${Buffer.from(digest(githubToken)).toString("hex")}`;
}

/**
 * A provider its person connected that a launch was not given, and why: their GitHub sign-in
 * can't be read now, GitHub refused a Copilot token (no Copilot access), GitHub couldn't be
 * asked (`copilot-unavailable`, which a later launch may not meet), or Chopin knows the key won't
 * work (`key-unusable`: its provider refused it as invalid, or this deployment can't decrypt it),
 * until it is connected again.
 */
export type AiWithheld = {
	provider: AiProvider;
	reason:
		| "sign-in-unavailable"
		| "not-connected"
		| "no-copilot-access"
		| "copilot-unavailable"
		| "key-unusable";
};

/** What a launch for a person would be given now: `providers` they can use, and what is `withheld`. */
export type AiAvailable = { providers: AiProvider[]; withheld: AiWithheld[] };

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
	/**
	 * Whether this process still holds the writer lease now: not released, not lost and not past
	 * its deadline. Cutoffs are counted in memory by the process that commits them, so one that no
	 * longer holds the lease may not hear of its successor's; it sends and serves nothing.
	 */
	writer?: () => boolean;
	/**
	 * The writer lease this process holds, which every cutoff it writes (a credential connected,
	 * replaced or removed, a launch or a machine's launches ended) is written under, checked in the
	 * same transaction; throws when it holds none.
	 */
	lease: () => Lease;
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

function summary(
	record: AiCredentialRecord,
	copilotAccess?: CopilotAccess,
	unusable = false,
): AiCredentialSummary {
	return {
		provider: record.provider,
		kind: record.kind,
		...(record.updatedAt.getTime() ? { updatedAt: record.updatedAt.toISOString() } : {}),
		...(record.suffix ? { suffix: record.suffix } : {}),
		...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt.toISOString() } : {}),
		...(record.rejectedAt ? { rejectedAt: record.rejectedAt.toISOString() } : {}),
		...(record.provider === "github-copilot" && copilotAccess ? { copilotAccess } : {}),
		...(unusable ? { unusable: true as const } : {}),
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
	readonly #writer: () => boolean;
	readonly #lease: () => Lease;
	readonly #copilotTokens = new Map<string, HeldAnswer>();
	/** How many of GitHub's answers about Copilot access have completed, numbering each as it does. */
	#completed = 0;
	/**
	 * For each Copilot account (`account`), the number of the latest completed answer of each kind,
	 * so answers are ordered by when GitHub gave them, not by when they were asked.
	 */
	readonly #answers = new Map<string, Record<"access" | "none", number>>();
	readonly #changed = new Set<(userId: string) => void>();

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
		this.#writer = options.writer ?? (() => true);
		this.#lease = options.lease;
	}

	/** The time by the clock deadlines are kept on, which the proxy's transport reads by default. */
	now(): number {
		return this.#clock().getTime();
	}

	/**
	 * A person's connected providers, never a secret, GitHub Copilot always among them. GitHub Copilot
	 * says whether it has Copilot access, asked with the token it was connected with, or for a GitHub
	 * sign-in `githubToken`, their own sign-in's current token. The answer may be a few minutes old.
	 * A key or token Chopin can no longer read is `unusable`.
	 */
	async list(userId: string, githubToken?: string): Promise<AiCredentialSummary[]> {
		let records = await this.#connected(userId);
		return Promise.all(records.map(async record =>
			summary(
				record,
				record.provider === "github-copilot"
					? (await this.#copilotAccess(record, await this.#connectedToken(record, githubToken)))
						.access
					: undefined,
				record.kind === "api-key" && !(await this.#secret(record)),
			)
		));
	}

	/** Asks GitHub again whether the person's GitHub Copilot has Copilot access, as Check again does. */
	async check(userId: string, githubToken: string): Promise<AiCredentialSummary> {
		let record = await this.#storage.aiCredentials.get(userId, "github-copilot") ?? signIn(userId);
		return summary(
			record,
			(await this.#copilotAccess(record, await this.#connectedToken(record, githubToken), true))
				.access,
			record.kind === "api-key" && !(await this.#secret(record)),
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
		await this.#storage.aiCredentials.put(this.#lease(), record);
		this.#told(userId);
		return summary(
			record,
			provider === "github-copilot"
				? (await this.#copilotAccess(record, await this.#connectedToken(record, githubToken), true))
					.access
				: undefined,
		);
	}

	async disconnect(userId: string, provider: AiProvider): Promise<boolean> {
		let removed = await this.#storage.aiCredentials.delete(this.#lease(), userId, provider);
		if (removed) this.#told(userId);
		return removed;
	}

	/**
	 * Calls `listener` with the person's id once they connected, replaced or removed a provider, so
	 * a launch that lasts can be prepared again with what they have now. Returns how to stop.
	 */
	onChanged(listener: (userId: string) => void): () => void {
		this.#changed.add(listener);
		return () => this.#changed.delete(listener);
	}

	#told(userId: string): void {
		for (let listener of this.#changed) {
			try {
				listener(userId);
			} catch (err) {
				console.error("chopin: a change of AI credentials could not be told -", err);
			}
		}
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
	 * token at this launch; otherwise it is `withheld`, with the reason. A launch on a document is
	 * prepared in the archive generation the document is open in when it begins, and its
	 * placeholders are stored only while the document is still open in it. Once they are stored,
	 * the person's credentials are read a final time, and the grants are published (none included)
	 * in the same step as the last check, with nothing awaited between, only while all of it holds:
	 * that read found the very credentials the launch was prepared with, none was connected,
	 * replaced or removed since it began, GitHub has given no answer of the other kind about the
	 * same Copilot account since the launch asked (a Check again, another launch or a proxied
	 * request; answers are ordered by when they completed), its machine is not revoked, its
	 * document is open in the same generation, and the launch has not reached its deadline. The
	 * machine and the document are read again when a cutoff completed while the final reads were
	 * made, so an archive or a revocation after their read and before the credentials' is in the
	 * decision. A launch past its deadline, or whose machine was revoked or document archived
	 * meanwhile (restored or not), takes its placeholders back and is given nothing; any other
	 * change takes them back and prepares the launch afresh, keys and all, at most
	 * `LAUNCH_ATTEMPTS` times, and then throws a retryable `AiCredentialError` (503) rather than
	 * give nothing. So no grant is returned for a credential that changed before it was, nor
	 * without one that was added. With no grants nothing is stored, and the caller starts no
	 * runner.
	 */
	async launch(input: AiLaunch): Promise<AiLaunchGrants> {
		let launchId = crypto.randomUUID();
		let launchToken = LAUNCH_PREFIX + randomBytes(32).toString("base64url");
		let launchDigest = digest(launchToken);
		let withheld: AiWithheld[] = [];
		let cancelled = () => ({ launchId, launchToken, grants: [], withheld });
		let generation = input.channelId === undefined
			? undefined
			: await this.#storage.aiPlaceholders.generation(input.channelId);
		if (input.channelId !== undefined && generation === undefined) return cancelled();
		for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt++) {
			let admitted = await this.#admitted(input, true);
			withheld = admitted.withheld;
			let grants: AiProviderGrant[] = admitted.usable.map(record => ({
				provider: record.provider,
				baseUrl: aiBaseUrl(this.#origin, record.provider),
				placeholder: PLACEHOLDER_PREFIX + randomBytes(32).toString("base64url"),
				keyVariable: AI_KEY_VARIABLES[record.provider],
			}));
			if (
				grants.length
				&& !await this.#storage.aiPlaceholders.put(
					this.#rows(launchId, launchDigest, input, generation, grants),
				)
			) return cancelled();
			let version = this.#storage.aiCredentials.version(input.userId);
			let cutoffs = this.#storage.aiPlaceholders.cutoffs();
			let [current, open] = await Promise.all([
				this.#connected(input.userId),
				this.#prepared(input, generation),
			]);
			// An archive or a revocation that completed after the document and machine were read,
			// while the accounts still were, moved the count: they are read again, so the grants are
			// never published on a read it outdated.
			for (
				let read = 1;
				open && read < HANDOFF_ATTEMPTS && this.#storage.aiPlaceholders.cutoffs() !== cutoffs;
				read++
			) {
				cutoffs = this.#storage.aiPlaceholders.cutoffs();
				open = await this.#prepared(input, generation);
			}
			let held = this.#storage.aiCredentials.version(input.userId) === version
				&& this.#storage.aiPlaceholders.cutoffs() === cutoffs
				&& sameSet(admitted.connected, current)
				&& !this.#contradicted(admitted.copilot);
			let due = this.#clock() >= input.expiresAt;
			if (held && open && !due) return { launchId, launchToken, grants, withheld };
			if (grants.length) await this.#storage.aiPlaceholders.deleteLaunch(this.#lease(), launchId);
			if (due || !open) return cancelled();
		}
		// Never a launch given nothing for want of a stable read while a verified key is there.
		throw new AiCredentialError(
			"Your AI accounts kept changing while this launch was prepared. Start it again.",
			503,
		);
	}

	/**
	 * What a launch for `userId` would be given now, without preparing one: nothing is stored. The
	 * providers they can use, and those they connected that a launch would not be given, with why.
	 * GitHub's answer about Copilot access may be a few minutes old, as the list's is. A read during
	 * which their credentials change, or GitHub says otherwise about their Copilot account, is read
	 * again, at most `LAUNCH_ATTEMPTS` times, and then it throws the retryable `AiCredentialError`
	 * (503) `launch` throws, rather than say they have nothing.
	 */
	async available(userId: string): Promise<AiAvailable> {
		for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt++) {
			let version = this.#storage.aiCredentials.version(userId);
			let admitted = await this.#admitted({ userId }, false);
			if (
				this.#storage.aiCredentials.version(userId) === version
				&& !this.#contradicted(admitted.copilot)
			) {
				return {
					providers: admitted.usable.map(record => record.provider),
					withheld: admitted.withheld,
				};
			}
		}
		throw new AiCredentialError(
			"Your AI accounts kept changing while Chopin read them. Try again.",
			503,
		);
	}

	/**
	 * Whether a launch can still be given what it was prepared with: its machine is not revoked, and
	 * its document is open in the archive generation the launch began in, so a document archived
	 * meanwhile, and restored or not, cancels it.
	 */
	async #prepared(input: AiLaunch, generation: number | undefined): Promise<boolean> {
		let [machine, open] = await Promise.all([
			input.machineId ? this.#storage.machines.get(input.machineId) : undefined,
			input.channelId ? this.#storage.aiPlaceholders.generation(input.channelId) : undefined,
		]);
		if (input.machineId && (!machine || machine.revokedAt)) return false;
		return open === generation;
	}

	/**
	 * The person's connected providers (`connected`), those a launch can be given now, and those it
	 * can't, with why. `copilot` is what GitHub answered about Copilot access, asked again when
	 * `fresh`, as every launch does. A key is given only when it decrypts and its provider hasn't
	 * refused it as invalid.
	 */
	async #admitted(input: Pick<AiLaunch, "userId" | "machineId">, fresh: boolean) {
		let copilot: CopilotAnswer | undefined;
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
				copilot = await this.#copilotAccess(record, token, fresh);
				if (copilot.access !== "access") {
					withheld.push({
						provider: record.provider,
						reason: copilot.access === "none" ? "no-copilot-access" : "copilot-unavailable",
					});
					continue;
				}
			} else if (record.rejectedAt || !await this.#secret(record)) {
				withheld.push({ provider: record.provider, reason: "key-unusable" });
				continue;
			}
			usable.push(record);
		}
		return { connected, usable, withheld, copilot };
	}

	/**
	 * Whether GitHub has said otherwise about the same Copilot account since `answer` was asked: an
	 * answer of the other kind completed after the question was put, whichever was asked first, and,
	 * for a question GitHub couldn't answer, any answer at all.
	 */
	#contradicted(answer: CopilotAnswer | undefined): boolean {
		let latest = answer?.account === undefined ? undefined : this.#answers.get(answer.account);
		if (!answer || !latest) return false;
		let other = answer.access === "access"
			? latest.none
			: answer.access === "none"
			? latest.access
			: Math.max(latest.access, latest.none);
		return other > answer.since;
	}

	#rows(
		launchId: string,
		launchDigest: Uint8Array,
		input: AiLaunch,
		generation: number | undefined,
		grants: AiProviderGrant[],
	): AiPlaceholder[] {
		return grants.map(grant => ({
			digest: digest(grant.placeholder),
			launchId,
			launchDigest,
			userId: input.userId,
			provider: grant.provider,
			...(input.machineId ? { machineId: input.machineId } : {}),
			...(input.channelId ? { channelId: input.channelId, generation } : {}),
			expiresAt: input.expiresAt,
		}));
	}

	/**
	 * Records that the provider answered a request sent with `record`, the key as it was read, that
	 * the key is invalid: no launch is given that key again, and the list says it needs connecting
	 * again. A key replaced or removed since keeps nothing of it.
	 */
	async rejected(record: AiCredentialRecord): Promise<void> {
		if (record.kind !== "api-key") return;
		await this.#storage.aiCredentials.rejected(record, this.#clock());
	}

	/** Ends a launch: its placeholders stop working at once. */
	async end(launchId: string): Promise<void> {
		await this.#storage.aiPlaceholders.deleteLaunch(this.#lease(), launchId);
	}

	/** Ends every launch on a machine, as revoking it does. */
	async machineEnded(machineId: string): Promise<void> {
		await this.#storage.aiPlaceholders.deleteForMachine(this.#lease(), machineId);
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
	 * a launch that ended before `serve` is never served. Nothing is served once this process no
	 * longer holds the writer lease (`restarting`), as nothing is sent: its successor's cutoffs are
	 * not counted here.
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
			if (!this.#writer()) return { refused: "restarting" };
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
	 * `prepare` builds the whole request for that credential and returns its admission to the
	 * transport. Last, with nothing awaited between this check and that admission: when a cutoff (a
	 * launch ended, a machine revoked, a document archived, a credential connected or removed)
	 * completed while they were read, they are read again; the launch must not have reached its
	 * deadline; and a Copilot token whose deadline came meanwhile is renewed and the request
	 * prepared again. The admission hands both deadlines to the transport, which checks them on the
	 * clock reading it takes the send at: a launch past its deadline then is refused, and a token
	 * past its own is renewed and the whole check made again. The credential's last use is recorded
	 * at that reading, for the very credential sent. Nothing is sent once `signal` is aborted, as a
	 * drain abandoning the request does (`cancelled`), nor once this process no longer holds the
	 * writer lease (`restarting`), since a cutoff its successor commits is not counted here. So a
	 * request is refused when its launch ended or expired, its machine was revoked or its document
	 * archived (`launch-ended`), when its person disconnected the provider (`not-connected`), or
	 * when the credential it was admitted with, or the one a renewed Copilot token came from, was
	 * replaced, or removed and connected again (`credential-changed`), whenever that completed
	 * before the send, and never carries an expired Copilot token or another account's. Cutoffs
	 * that keep completing while it reads refuse it as `busy`.
	 */
	async handoff<T>(
		authorized: AiAuthorized,
		prepare: (authorized: AiAuthorized) => (deadlines: AiDeadlines) => AiAdmitted<T>,
		signal?: AbortSignal,
	): Promise<T | { refused: AiRefusal }> {
		let current = authorized;
		let renew = false;
		for (let attempt = 0; attempt < HANDOFF_ATTEMPTS; attempt++) {
			if (renew || expired(current, this.#clock())) {
				let renewed = await this.#credential(current.placeholder, renew);
				if ("refused" in renewed) return renewed;
				current = renewed;
				renew = false;
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
			// The credential that gave a renewed Copilot token must be the one admitted and the one
			// connected now: a credential connected only while it was renewed is another account's.
			if (!unchanged(authorized.record, record) || !unchanged(current.record, record)) {
				return { refused: "credential-changed" };
			}
			let enter = prepare(current);
			if (this.#storage.aiPlaceholders.cutoffs() !== cutoffs) continue;
			if (signal?.aborted) return { refused: "cancelled" };
			if (!this.#writer()) return { refused: "restarting" };
			let now = this.#clock();
			if (now >= found.expiresAt) return { refused: "launch-ended" };
			if (expired(current, now)) continue;
			let admitted = enter({
				launch: found.expiresAt.getTime(),
				...(current.expiresAt === undefined ? {} : { token: current.expiresAt }),
			});
			if ("late" in admitted) {
				if (admitted.late === "launch") return { refused: "launch-ended" };
				renew = true;
				continue;
			}
			this.#used(record, new Date(admitted.at));
			return admitted.sent;
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

	async #credential(
		found: AiPlaceholder,
		fresh = false,
	): Promise<AiAuthorized | { refused: AiRefusal }> {
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
			copilot = await this.#copilotToken(record, token, fresh);
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
	 * which is used for a few minutes unless `fresh`, with how many answers had completed when it was
	 * asked (`since`). A refusal is `none`, not an error; a token Chopin can't read, or a question
	 * GitHub couldn't answer, is `unknown`, which no record keeps.
	 */
	async #copilotAccess(
		record: AiCredentialRecord,
		githubToken: string | undefined,
		fresh = false,
	): Promise<CopilotAnswer> {
		let since = this.#completed;
		if (!githubToken) return { access: "unknown", since };
		let account = copilotAccount(record, githubToken);
		try {
			let answer = await this.#copilotAnswer(account, githubToken, fresh);
			return { account, access: answer.token ? "access" : "none", since: answer.since };
		} catch {
			return { account, access: "unknown", since };
		}
	}

	async #copilotToken(
		record: AiCredentialRecord,
		githubToken: string,
		fresh = false,
	): Promise<CopilotToken | undefined> {
		return (await this.#copilotAnswer(copilotAccount(record, githubToken), githubToken, fresh))
			.token;
	}

	/**
	 * The Copilot token GitHub gives `githubToken`, asked once for every caller at a time and held
	 * until a minute before it expires, or five minutes at most, so a seat GitHub removes is noticed,
	 * with how many answers had completed when it was asked. A refusal is held as long; a failure is
	 * not held. A token that has expired by the time a caller has it, one GitHub gave already expired
	 * or one that expired while GitHub answered, is a failure: it is never returned.
	 */
	async #copilotAnswer(
		account: string,
		githubToken: string,
		fresh = false,
	): Promise<{ token: CopilotToken | undefined; since: number }> {
		let key = Buffer.from(digest(githubToken)).toString("hex");
		let now = this.#clock().getTime();
		let held = this.#copilotTokens.get(key);
		let entry = !fresh && held && now < held.until
			? held
			: this.#ask(key, account, githubToken, now);
		let token = await entry.answer;
		if (token && token.expiresAt <= this.#clock().getTime()) {
			if (this.#copilotTokens.get(key) === entry) this.#copilotTokens.delete(key);
			throw new CopilotTokenExpired();
		}
		return { token, since: entry.since };
	}

	#ask(key: string, account: string, githubToken: string, now: number) {
		for (let [other, entry] of this.#copilotTokens) {
			if (entry.until <= now) this.#copilotTokens.delete(other);
		}
		let entry: HeldAnswer = {
			answer: Promise.resolve(undefined),
			until: now + ACCESS_KNOWN_MS,
			account,
			since: this.#completed,
		};
		entry.answer = this.#asked(key, entry, githubToken);
		this.#copilotTokens.set(key, entry);
		return entry;
	}

	/**
	 * GitHub's answer for `entry`, recorded before any caller resumes with it. GitHub decides an
	 * answer before Chopin has it, so one that crossed an answer of the other kind about the same
	 * account (the other completed after this one was asked) may have been decided first: it is
	 * dropped and GitHub asked again, at most `ANSWER_ATTEMPTS` times, after which it is a failure,
	 * like one GitHub couldn't give.
	 */
	async #asked(
		key: string,
		entry: HeldAnswer,
		githubToken: string,
	): Promise<CopilotToken | undefined> {
		try {
			for (let attempt = 0; attempt < ANSWER_ATTEMPTS; attempt++) {
				if (attempt) entry.since = this.#completed;
				let token = await this.#exchange(githubToken);
				let access = token ? "access" as const : "none" as const;
				if (this.#crossed(entry, access)) continue;
				if (token) entry.until = Math.min(entry.until, token.expiresAt - RENEW_BEFORE_MS);
				// A token already expired is no answer, as every caller takes it.
				if (!token || token.expiresAt > this.#clock().getTime()) this.#answered(entry, access);
				return token;
			}
			throw new Error("GitHub's answers about this Copilot account kept crossing others");
		} catch (err) {
			if (this.#copilotTokens.get(key) === entry) this.#copilotTokens.delete(key);
			throw err;
		}
	}

	/** Whether an answer of the other kind about `entry`'s account completed after it was asked. */
	#crossed(entry: HeldAnswer, access: "access" | "none"): boolean {
		let latest = this.#answers.get(entry.account);
		return !!latest && latest[access === "access" ? "none" : "access"] > entry.since;
	}

	/**
	 * Records GitHub's answer about an account as the latest of its kind, numbered as it completes,
	 * and stops using any answer held about the same account that says otherwise, whichever of its
	 * tokens asked: that answer is older, and the next question about it asks GitHub again. Another
	 * account, a token connected instead of the sign-in, keeps its own.
	 */
	#answered(entry: HeldAnswer, access: "access" | "none"): void {
		entry.access = access;
		let latest = this.#answers.get(entry.account) ?? { access: 0, none: 0 };
		latest[access] = ++this.#completed;
		this.#answers.set(entry.account, latest);
		for (let [key, other] of this.#copilotTokens) {
			if (other.account === entry.account && other.access && other.access !== access) {
				this.#copilotTokens.delete(key);
			}
		}
	}
}
