import { createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import {
	AI_KEY_VARIABLES,
	AI_PROXY_PATH,
	isSubscriptionProvider,
} from "@chopin/protocol/ai-credentials";

import { decrypted, encrypted, imported } from "../auth/session";
import { COPILOT_RAW_TOKEN_HEADERS } from "./copilot";
import { catalogOnly } from "./launches";
import { AI_UPSTREAMS } from "./proxy";
import {
	beginSignIn,
	finishSignIn,
	pastedAnswer,
	RefreshRefused,
	refreshSignIn,
	SignInFailed,
	SUBSCRIPTION_NAMES,
} from "./subscriptions";

import type {
	AiCredentialSummary,
	AiProvider,
	AiProviderGrant,
	ConnectAiCredential,
	CopilotAccess,
	SubscriptionProvider,
} from "@chopin/protocol/ai-credentials";
import type { AiCredentialRecord, AiPlaceholder, Lease } from "../storage/model";
import type { CopilotToken, CopilotTokenExchange } from "./copilot";
import type { PendingSignIn, SignInEndpoints, SubscriptionTokens } from "./subscriptions";
import type { StorageAdapter } from "../storage/port";

const CREDENTIAL_CONTEXT = "chopin:ai-credential:v1";
const PLACEHOLDER_PREFIX = "chopin_ai_";
/**
 * What a Claude sign-in's stand-in starts with after the prefix: the mark of Claude's OAuth tokens,
 * so an agent that tells them from keys by it sends the stand-in the way a subscription token goes.
 */
const CLAUDE_TOKEN_MARK = "sk-ant-oat01-";
/** How long a sign-in begun waits for the person to paste the provider's answer. */
const SIGN_IN_MS = 15 * 60 * 1000;
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
/**
 * How long a launch just handed out counts as owned while its owner takes it up (a session holds it
 * once its start is sent): no sweep ends it meanwhile for want of an owner.
 */
const HANDED_MS = 2 * 60_000;
/** How soon an end that storage refused is tried again, at first; it doubles to `END_RETRY_MAX_MS`. */
const END_RETRY_MS = 5_000;
const END_RETRY_MAX_MS = 5 * 60_000;

type Clock = () => Date;

/**
 * Why a connection was refused, said to the person who asked, with the status that says it, and for
 * a sign-in whether it must be started again (`restart`): the one begun ended or was spent.
 */
export class AiCredentialError extends Error {
	override name = "AiCredentialError";
	constructor(message: string, readonly status = 422, readonly restart = false) {
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
	| "sign-in-ended"
	| "renew-unavailable"
	| "cancelled"
	| "restarting"
	| "busy"
	| "catalog-only";

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
	/** Headers the provider is sent with `secret`, replacing any the agent sent by those names. */
	headers?: Record<string, string>;
};

/** What a launch is handed: `launchToken` stays with its runner, `grants` go to its agent. */
export type AiLaunchGrants = {
	launchId: string;
	/** The launch's own credential, sent by its runner in `AI_LAUNCH_HEADER`; never its agent's. */
	launchToken: string;
	grants: AiProviderGrant[];
	withheld: AiWithheld[];
	/**
	 * The launch ended before it was handed out: its document was archived, its machine revoked or
	 * its grants taken back with the machine's, or its deadline passed. It is given nothing, and not
	 * for want of an account.
	 */
	ended?: true;
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
 * With access, `expiresAt` is when what Copilot takes for the token stops being good (milliseconds
 * since the epoch), as `CopilotToken`'s is.
 */
type CopilotAnswer = { access: CopilotAccess; since: number; account?: string; expiresAt?: number };

/**
 * GitHub's answer about one GitHub token for one account, held for the next questions about both:
 * the account it is about, how many answers had completed when it was asked, and, once it has,
 * what it answered.
 */
type HeldAnswer = {
	answer: Promise<CopilotToken | undefined>;
	until: number;
	account: string;
	since: number;
	access?: "access" | "none";
};

/** What GitHub's answers about one Copilot account came to (see `AiCredentials.#answers`). */
type AccountAnswers = Record<"access" | "none", number> & {
	settled?: "access" | "none" | "disputed";
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
 * can't be read now, GitHub said the account has no Copilot subscription (`no-copilot-access`),
 * GitHub couldn't be asked or gave no answer about the account, as when neither its exchange nor
 * Copilot's model API takes the token (`copilot-unavailable`, which a later launch may not meet),
 * Chopin knows the key or sign-in won't work (`key-unusable`: its provider refused it as invalid or
 * refused to renew the sign-in, or this deployment can't decrypt it), until it is connected again,
 * or a sign-in's expired access token couldn't be renewed now (`renew-unavailable`, which a later
 * launch may not meet).
 */
export type AiWithheld = {
	provider: AiProvider;
	reason:
		| "sign-in-unavailable"
		| "not-connected"
		| "no-copilot-access"
		| "copilot-unavailable"
		| "key-unusable"
		| "renew-unavailable";
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
	/**
	 * What the launch is for, whose end ends it: `run:<id>` for a run on a paired machine,
	 * `session:<id>` for a Planner session, or `link:<id>` for the catalog launch of an attached
	 * link, which lists models and runs none (see `AiCredentialsOptions.ownerLive`, `catalogOnly`).
	 */
	owner?: string;
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
	/** Where ChatGPT and Claude sign in and renew; their own unless tests point them at fakes. */
	signIns?: SignInEndpoints;
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
	/**
	 * Whether what a launch is for (its `owner`, with its document) is still live: the run still
	 * running, the session still held. Read with every final check, so a launch whose run or session
	 * ended stops working whichever process ended it and whether or not its end reached storage. A
	 * launch with no owner, as one from before owners were kept, is live until it ends or expires.
	 */
	ownerLive?: (launch: Pick<AiPlaceholder, "launchId" | "owner" | "channelId">) =>
		| boolean
		| Promise<boolean>;
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

/**
 * Whether `current` is the very set of credentials `read` was, provider by provider, each refused
 * as invalid or not as it was read: a key refused since is no longer one a launch may be given.
 */
function sameSet(read: AiCredentialRecord[], current: AiCredentialRecord[]): boolean {
	return read.length === current.length
		&& read.every(record => {
			let now = current.find(value => value.provider === record.provider);
			return unchanged(record, now)
				&& now!.rejectedAt?.getTime() === record.rejectedAt?.getTime();
		});
}

function summary(
	record: AiCredentialRecord,
	copilotAccess?: CopilotAccess,
	unusable = false,
	unchecked = false,
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
		...(unchecked ? { unchecked: true as const } : {}),
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
	let versioned = provider === "openai" || provider === "chatgpt";
	return `${origin}${AI_PROXY_PATH}/${provider}${versioned ? "/v1" : ""}`;
}

/** The connection a credential is, across its sign-in's refreshes: its person, provider and secret. */
function connection(record: AiCredentialRecord): string {
	return `${record.userId}\n${record.provider}\n${record.updatedAt.getTime()}\n${
		record.ciphertext ? Buffer.from(record.ciphertext).toString("hex") : ""
	}`;
}

/** A UUID of this deployment's own, derived from its key, which ChatGPT takes as the agent host. */
function deploymentUuid(key: Uint8Array): string {
	let bytes = new Uint8Array(hkdfSync("sha256", key, "", "chopin:ai-sign-in-host:v1", 16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	let hex = Buffer.from(bytes).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
		hex.slice(20)
	}`;
}

/** What renewing a sign-in came to: its tokens, ended for good, or not possible now. */
type Renewed = SubscriptionTokens | "ended" | "unavailable" | undefined;

/** A renewed pair, and as stored, that storage hasn't taken yet. */
type UnsavedTokens = { tokens: SubscriptionTokens; sealed: Uint8Array };

/**
 * The AI credentials people connect in Chopin, and the placeholders launches hold instead. A key
 * is kept encrypted under a key derived from SESSION_ENCRYPTION_KEY and is read only to answer a
 * proxied request; nothing returns it. A ChatGPT or Claude sign-in's tokens are kept the same way,
 * and its access token is renewed before it expires, once for every caller at a time. A launch is handed a random placeholder per provider its
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
	readonly #signInEndpoints: SignInEndpoints | undefined;
	readonly #hostId: string;
	readonly #fetch: typeof fetch;
	readonly #writer: () => boolean;
	readonly #lease: () => Lease;
	readonly #copilotTokens = new Map<string, HeldAnswer>();
	/** How many of GitHub's answers about Copilot access have completed, numbering each as it does. */
	#completed = 0;
	/**
	 * For each Copilot account (`account`), the number of the latest completed answer of each kind,
	 * kept or not, so answers are ordered by when GitHub gave them, not by when they were asked; and
	 * what the account is `settled` on: the kind of the latest answer kept, or `disputed` once an
	 * answer of the other kind crossed it, until GitHub answers a question put since.
	 */
	readonly #answers = new Map<string, AccountAnswers>();
	readonly #changed = new Set<(userId: string) => void>();
	/** Whose credentials each Copilot account answers for, to tell them when its answer changes. */
	readonly #accountUsers = new Map<string, Set<string>>();
	readonly #ownerLive: NonNullable<AiCredentialsOptions["ownerLive"]>;
	/**
	 * The launches this process ended, or is ending: none is admitted from the moment its end is
	 * asked, before storage has it, and one whose end storage refused stays here and is ended again.
	 */
	readonly #ending = new Set<string>();
	/** The ends storage refused, tried again on a backoff and with each sweep. */
	readonly #unended = new Map<string, number>();
	#retrying: ReturnType<typeof setTimeout> | undefined;
	/** Launches handed out lately, by id, with when: their owner may not have taken them up yet. */
	readonly #handed = new Map<string, number>();
	/** Sign-ins begun and not yet finished, by person and provider, with when each lapses and its attempt. */
	readonly #signIns = new Map<string, PendingSignIn & { until: number; attempt: number }>();
	/**
	 * The latest sign-in attempt of each person and provider, numbered as each begins: it lasts
	 * through its code's exchange, and only it may save what that returns. A newer sign-in, or a
	 * disconnect, ends the one before.
	 */
	readonly #attempts = new Map<string, number>();
	#attempt = 0;
	/**
	 * The last renewal queued for each sign-in's connection, which the next one waits for, and the last
	 * sign-in's save or disconnect queued for each person and provider, which the next one waits for.
	 */
	readonly #renewing = new Map<string, Promise<void>>();
	/** A sign-in's renewed pair storage couldn't take yet, by connection, sent and saved until it is. */
	readonly #unsaved = new Map<string, UnsavedTokens>();
	/**
	 * How many times this process changed a sign-in's pair, as it holds it or as storage has it (a
	 * refusal making it due, a renewal), counted as each change is made and again as storage settles
	 * it, so a send that read a pair while one was made reads it again.
	 */
	#pairs = 0;

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
		this.#signInEndpoints = options.signIns;
		this.#hostId = deploymentUuid(options.key);
		this.#fetch = options.fetch ?? fetch;
		this.#writer = options.writer ?? (() => true);
		this.#lease = options.lease;
		this.#ownerLive = options.ownerLive ?? (() => true);
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
		return Promise.all(records.map(async record => {
			if (record.kind === "subscription") return this.#signInSummary(record);
			return summary(
				record,
				record.provider === "github-copilot"
					? (await this.#copilotAccess(record, await this.#connectedToken(record, githubToken)))
						.access
					: undefined,
				record.kind === "api-key" && !(await this.#secret(record)),
			);
		}));
	}

	/**
	 * A sign-in as the list says it: renewed first when its access token expired or its provider
	 * refused it, so it reads as connected only while the provider still renews it. One whose
	 * renewal the provider refused for good needs signing in again; one that couldn't be renewed now
	 * is `unchecked`.
	 */
	async #signInSummary(record: AiCredentialRecord): Promise<AiCredentialSummary> {
		if (record.rejectedAt) return summary(record);
		let renewed = await this.#signedIn(record, false);
		if (renewed === "ended") {
			return summary((await this.#record(record.userId, record.provider)) ?? record);
		}
		return summary(record, undefined, renewed === undefined, renewed === "unavailable");
	}

	/**
	 * Begins signing `userId` in to a subscription: the provider's page they open, whose answer
	 * `finishSignIn` takes. A sign-in begun again replaces the one before, which saves nothing even
	 * once its code was sent; nothing is stored, and what they connected before is untouched until the
	 * provider gives tokens.
	 */
	startSignIn(userId: string, provider: SubscriptionProvider): { url: string } {
		let now = this.#clock().getTime();
		for (let [key, pending] of this.#signIns) {
			if (pending.until > now) continue;
			this.#signIns.delete(key);
			if (this.#attempts.get(key) === pending.attempt) this.#attempts.delete(key);
		}
		let pending = beginSignIn(provider, this.#hostId, this.#signInEndpoints);
		let key = `${userId}\n${provider}`;
		let attempt = ++this.#attempt;
		this.#attempts.set(key, attempt);
		this.#signIns.set(key, { ...pending, until: now + SIGN_IN_MS, attempt });
		return { url: pending.url };
	}

	/**
	 * Finishes the sign-in `userId` began with what they pasted: checked against the sign-in before
	 * anything is sent, then exchanged for the subscription's tokens, which are stored encrypted in
	 * place of what they connected for it before. A paste that isn't the sign-in's answer keeps the
	 * sign-in to paste again; once the code is sent it is spent, and a refusal stores nothing. The
	 * tokens are saved only while this is still their latest sign-in for the provider, with no
	 * disconnect since it began, in turn with disconnects, and in storage only over the connection
	 * stored as its exchange began: one that a newer sign-in or a disconnect overtook saves nothing.
	 */
	async completeSignIn(
		userId: string,
		provider: SubscriptionProvider,
		input: string,
	): Promise<AiCredentialSummary> {
		let key = `${userId}\n${provider}`;
		let name = SUBSCRIPTION_NAMES[provider];
		let pending = this.#signIns.get(key);
		if (!pending || pending.until <= this.#clock().getTime()) {
			this.#signIns.delete(key);
			throw new AiCredentialError(`This ${name} sign-in has ended. Start it again.`, 422, true);
		}
		let answer: ReturnType<typeof pastedAnswer>;
		try {
			answer = pastedAnswer(pending, input);
		} catch (err) {
			if (err instanceof SignInFailed) throw new AiCredentialError(err.message, err.status);
			throw err;
		}
		if (this.#signIns.get(key) === pending) this.#signIns.delete(key);
		let attempt = pending.attempt;
		try {
			let replaced = await this.#storage.aiCredentials.get(userId, provider);
			let tokens: SubscriptionTokens;
			try {
				tokens = await finishSignIn(pending, answer, {
					fetch: this.#fetch,
					now: this.#clock().getTime(),
					endpoints: this.#signInEndpoints,
				});
			} catch (err) {
				if (err instanceof SignInFailed) {
					throw new AiCredentialError(err.message, err.status, true);
				}
				throw err;
			}
			let record: AiCredentialRecord = {
				userId,
				provider,
				kind: "subscription",
				ciphertext: await encrypted(await this.#key, aad(userId, provider), { tokens }),
				updatedAt: this.#clock(),
			};
			let saved = await this.#serially(key, async () =>
				this.#attempts.get(key) === attempt
				&& await this.#storage.aiCredentials.signedIn(this.#lease(), record, replaced));
			if (!saved) {
				throw new AiCredentialError(
					`This ${name} sign-in was replaced by a newer one, or ${name} was disconnected, before it finished. Start it again.`,
					409,
					true,
				);
			}
			this.#forgetReplaced(userId, provider, connection(record));
			this.#told(userId);
			return summary(record);
		} finally {
			if (this.#attempts.get(key) === attempt) this.#attempts.delete(key);
		}
	}

	/**
	 * Asks GitHub again whether the person's GitHub Copilot has Copilot access, as the AI accounts
	 * page does when it opens.
	 */
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
		if (isSubscriptionProvider(provider)) {
			throw new AiCredentialError(
				`Sign in to connect ${SUBSCRIPTION_NAMES[provider]}; it takes no key.`,
			);
		}
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
		let key = `${userId}\n${provider}`;
		// A sign-in begun before this, its code sent or not, ends here and saves nothing; one that
		// is saving already finishes first, and what it saved is removed.
		this.#signIns.delete(key);
		this.#attempts.delete(key);
		let removed = await this.#serially(
			key,
			() => this.#storage.aiCredentials.delete(this.#lease(), userId, provider),
		);
		this.#forgetReplaced(userId, provider);
		if (removed) this.#told(userId);
		return removed;
	}

	/**
	 * Calls `listener` with the person's id once what a launch for them may be given changed: they
	 * connected, replaced or removed a provider, their provider refused a key of theirs as invalid, or
	 * GitHub's answer about their Copilot access changed. So a launch that lasts can be prepared
	 * again with what they have now. Returns how to stop.
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
	 * returned. GitHub Copilot is given only when the person's GitHub token has Copilot access at this
	 * launch (see `copilotTokenExchange`); otherwise it is `withheld`, with the reason. A launch on a
	 * document is prepared in the archive generation the document is open in when it begins, and its
	 * placeholders are stored only while the document is still open in it. Once they are stored,
	 * the person's credentials are read a final time, and the grants are published (none included)
	 * in the same step as the last check, with nothing awaited between, only while all of it holds:
	 * that read found the very credentials the launch was prepared with, none was connected,
	 * replaced or removed since it began, GitHub has given no answer of the other kind about the
	 * same Copilot account since the launch asked (a check as the AI accounts page opens, another
	 * launch or a proxied request; answers are ordered by when they completed), its machine is not
	 * revoked, its document is open in the same generation, and, on one clock reading, neither the
	 * launch's deadline nor that of the Copilot token it is given Copilot for has come. The machine
	 * and the document are read again when a cutoff completed while the final
	 * reads were made, so an archive or a revocation after their read and before the credentials' is
	 * in the decision. A launch past its deadline, or whose machine was revoked or document archived
	 * meanwhile (restored or not), takes its placeholders back and is given nothing; any other
	 * change, a Copilot token that expired while the placeholders were stored among them, takes them
	 * back and prepares the launch afresh, keys and all, asking GitHub again, at most
	 * `LAUNCH_ATTEMPTS` times, and then throws a retryable `AiCredentialError` (503) rather than
	 * give nothing. So no grant is returned for a credential that changed before it was, nor
	 * without one that was added, nor Copilot for a token that expired before it was. With no grants
	 * nothing is stored, and the caller starts no runner.
	 */
	async launch(input: AiLaunch): Promise<AiLaunchGrants> {
		let launchId = crypto.randomUUID();
		let launchToken = LAUNCH_PREFIX + randomBytes(32).toString("base64url");
		let launchDigest = digest(launchToken);
		let withheld: AiWithheld[] = [];
		let cancelled = () => ({ launchId, launchToken, grants: [], withheld, ended: true as const });
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
				placeholder: record.provider === "claude"
					? PLACEHOLDER_PREFIX + CLAUDE_TOKEN_MARK + randomBytes(22).toString("base64url")
					: PLACEHOLDER_PREFIX + randomBytes(32).toString("base64url"),
				keyVariable: AI_KEY_VARIABLES[record.provider],
			}));
			let rows = this.#rows(launchId, launchDigest, input, generation, grants);
			if (grants.length && !await this.#storage.aiPlaceholders.put(rows)) return cancelled();
			let version = this.#storage.aiCredentials.version(input.userId);
			let cutoffs = this.#storage.aiPlaceholders.cutoffs();
			let [current, open] = await Promise.all([
				this.#connected(input.userId),
				this.#prepared(input, generation, rows),
			]);
			// An archive, a revocation or the end of the machine's launches that completed after the
			// document, machine and stored grants were read, while the accounts still were, moved the
			// count: they are read again, so the grants are never published on a read it outdated.
			for (
				let read = 1;
				open && read < HANDOFF_ATTEMPTS && this.#storage.aiPlaceholders.cutoffs() !== cutoffs;
				read++
			) {
				cutoffs = this.#storage.aiPlaceholders.cutoffs();
				open = await this.#prepared(input, generation, rows);
			}
			let held = this.#storage.aiCredentials.version(input.userId) === version
				&& this.#storage.aiPlaceholders.cutoffs() === cutoffs
				&& sameSet(admitted.connected, current)
				&& !this.#contradicted(admitted.copilot);
			// The launch's deadline and that of what Copilot takes for its token, on one reading.
			let now = this.#clock();
			let due = now >= input.expiresAt;
			let lapsed = now.getTime() >= (admitted.copilot?.expiresAt ?? Infinity);
			if (held && open && !due && !lapsed) {
				if (grants.length) this.#handedOut(launchId);
				return { launchId, launchToken, grants, withheld };
			}
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
	 * Whether a launch can still be given what it was prepared with: its machine is not revoked, its
	 * document is open in the archive generation the launch began in, so a document archived
	 * meanwhile, and restored or not, cancels it, and every grant it stored is still there, so one
	 * whose grants went with the machine's (a machine that must be paired again, not revoked) is
	 * never handed out without them.
	 */
	async #prepared(
		input: AiLaunch,
		generation: number | undefined,
		rows: readonly AiPlaceholder[],
	): Promise<boolean> {
		let now = this.#clock();
		let [machine, open, stored] = await Promise.all([
			input.machineId ? this.#storage.machines.get(input.machineId) : undefined,
			input.channelId ? this.#storage.aiPlaceholders.generation(input.channelId) : undefined,
			Promise.all(rows.map(row => this.#storage.aiPlaceholders.find(row.digest, now))),
		]);
		if (input.machineId && (!machine || machine.revokedAt)) return false;
		if (stored.some(row => !row)) return false;
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
			} else if (record.kind === "subscription") {
				let renewed = record.rejectedAt
					? "ended"
					: fresh
					? await this.#signedIn(record, false)
					: await this.#tokens(record);
				if (renewed === "unavailable") {
					withheld.push({ provider: record.provider, reason: "renew-unavailable" });
					continue;
				}
				if (!renewed || renewed === "ended") {
					withheld.push({ provider: record.provider, reason: "key-unusable" });
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
			...(input.owner ? { owner: input.owner } : {}),
			expiresAt: input.expiresAt,
		}));
	}

	/** Remembers a launch was just handed out, for its owner to take up; forgets old ones. */
	#handedOut(launchId: string): void {
		let now = this.#clock().getTime();
		for (let [id, at] of this.#handed) if (now - at >= HANDED_MS) this.#handed.delete(id);
		this.#handed.set(launchId, now);
	}

	/**
	 * Records that the provider answered a request sent with `record`, the key as it was read, and
	 * `secret`, what was sent for it, that the key is invalid: no launch is given that key again, and
	 * the list says it needs connecting again. A key replaced or removed since keeps nothing of it.
	 * Its person's launches that last are told, once, as when they remove it; a refusal of a key
	 * already marked, or replaced, tells no one. A sign-in's access token the provider refused is
	 * renewed before that token would be sent again, and the sign-in needs signing in again only once
	 * the provider refuses to renew it.
	 */
	async rejected(record: AiCredentialRecord, secret: string): Promise<void> {
		if (record.kind === "subscription") {
			let identity = connection(record);
			await this.#serially(identity, () => this.#due(record, identity, secret));
			return;
		}
		if (record.kind !== "api-key") return;
		if (await this.#storage.aiCredentials.rejected(record, this.#clock())) {
			this.#told(record.userId);
		}
	}

	/**
	 * Ends a launch: from the moment it is asked, this process admits nothing more for it, before
	 * storage has the end, and its placeholders stop working everywhere once storage has it. An end
	 * storage refuses is tried again, on a backoff and with each sweep, and nothing is admitted for
	 * the launch meanwhile.
	 */
	async end(launchId: string): Promise<void> {
		this.#ending.add(launchId);
		try {
			await this.#storage.aiPlaceholders.deleteLaunch(this.#lease(), launchId);
		} catch (err) {
			this.#endLater(launchId);
			throw err;
		}
		this.#ended(launchId);
	}

	/**
	 * Ends the launch `launchToken` is the credential of, for the machine it was handed out on;
	 * false when no live launch of that machine has it. Read from storage, so any process ends it,
	 * and from the moment it is found this process admits nothing more for it.
	 */
	async endHeld(launchToken: string, machineId: string): Promise<boolean> {
		let found = await this.#storage.aiPlaceholders.findLaunch(digest(launchToken), this.#clock());
		if (!found || found.machineId !== machineId) return false;
		this.#ending.add(found.launchId);
		let removed: number;
		try {
			removed = await this.#storage.aiPlaceholders.deleteHeldLaunch(
				this.#lease(),
				digest(launchToken),
				machineId,
			);
		} catch (err) {
			this.#endLater(found.launchId);
			throw err;
		}
		this.#ended(found.launchId);
		return removed > 0;
	}

	/** Storage has a launch's end: what it says from now on is enough. */
	#ended(launchId: string): void {
		this.#ending.delete(launchId);
		this.#unended.delete(launchId);
	}

	/** Storage refused a launch's end: it stays ended here, and is ended again soon. */
	#endLater(launchId: string): void {
		let delay = Math.min((this.#unended.get(launchId) ?? END_RETRY_MS / 2) * 2, END_RETRY_MAX_MS);
		this.#unended.set(launchId, delay);
		if (this.#retrying) return;
		this.#retrying = setTimeout(() => {
			this.#retrying = undefined;
			void this.#endAgain();
		}, Math.min(...this.#unended.values()));
		this.#retrying.unref?.();
	}

	/** Ends again each launch whose end storage refused. */
	async #endAgain(): Promise<void> {
		await Promise.all(
			[...this.#unended.keys()].map(launchId =>
				this.end(launchId).catch(err =>
					console.error("chopin: could not end an AI launch, and will try again -", err)
				)
			),
		);
	}

	/**
	 * Whether `launchToken` is the credential of a live launch: `live` while it is, `ended` once it
	 * ended, however that was (an end, an archive, a revocation, its deadline, its run or session
	 * ending), which a launch's runner reads, with its own credential, when the proxy refuses its
	 * agent, to tell an ended launch from a stand-in its agent got wrong. A credential no launch has
	 * reads as ended: only a launch's runner holds one. `restarting` from a process that no longer
	 * holds the writer lease, which can't tell.
	 */
	async launchStatus(launchToken: string): Promise<"live" | "ended" | "restarting"> {
		if (!launchToken.startsWith(LAUNCH_PREFIX)) return "ended";
		let found = await this.#storage.aiPlaceholders.findLaunch(digest(launchToken), this.#clock());
		if (!found || this.#ending.has(found.launchId)) return "ended";
		let live = await this.#launchLive(found);
		if (!this.#writer()) return "restarting";
		return live && !this.#ending.has(found.launchId) ? "live" : "ended";
	}

	/**
	 * Ends each launch nothing owns now (its run ended, its session gone), whichever process handed
	 * it out and whether or not an end was asked for it: what the writer lease's holder does as it
	 * starts and with each sweep. A launch handed out moments ago is left to its owner to take up.
	 * Returns how many it ended.
	 */
	async retire(): Promise<number> {
		await this.#endAgain();
		let now = this.#clock();
		let owned = await this.#storage.aiPlaceholders.owned(now);
		let ended = 0;
		for (let launch of owned) {
			let handed = this.#handed.get(launch.launchId);
			if (handed !== undefined && now.getTime() - handed < HANDED_MS) continue;
			if (this.#ending.has(launch.launchId) || await this.#ownerLive(launch)) continue;
			try {
				await this.end(launch.launchId);
				ended++;
			} catch (err) {
				console.error("chopin: could not end an AI launch nothing owns -", err);
			}
		}
		return ended;
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
			if (this.#ending.has(found.launchId) || this.#clock() >= found.expiresAt) {
				return { refused: "launch-ended" };
			}
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
	 * before it expires. A catalog-only launch (`catalogOnly`) is refused every request but a model
	 * list (`listing`), before any credential is read.
	 */
	async authorize(
		placeholder: string | undefined,
		provider: AiProvider,
		launchToken: string | undefined,
		listing = false,
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
		if (this.#ending.has(found.launchId) || !await this.#launchLive(found)) {
			return { refused: "launch-ended" };
		}
		if (catalogOnly(found.owner) && !listing) return { refused: "catalog-only" };
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
	 * before the send, and never carries an expired Copilot token or another account's. A sign-in's
	 * request is sent only with the pair the sign-in has at that last check, which is read with the
	 * rest and must be the very pair the request was prepared with, its expiry checked on the same
	 * clock reading as the launch's deadline: one the provider refused since, or that was renewed
	 * since, is read again and renewed first, and one whose renewal the provider refused for good
	 * refuses the request (`sign-in-ended`). Cutoffs
	 * that keep completing while it reads refuse it as `busy`.
	 */
	async handoff<T>(
		authorized: AiAuthorized,
		prepare: (authorized: AiAuthorized) => (deadlines: AiDeadlines) => AiAdmitted<T>,
		signal?: AbortSignal,
	): Promise<T | { refused: AiRefusal }> {
		let current = authorized;
		let renew = false;
		/** A sign-in's pair is not the one `current` was prepared with: it is taken again. */
		let reread = false;
		for (let attempt = 0; attempt < HANDOFF_ATTEMPTS; attempt++) {
			if (renew || reread || expired(current, this.#clock())) {
				let renewed = await this.#credential(current.placeholder, renew);
				if ("refused" in renewed) return renewed;
				current = renewed;
				renew = reread = false;
			}
			let placeholder = current.placeholder;
			let cutoffs = this.#storage.aiPlaceholders.cutoffs();
			let pairs = this.#pairs;
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
			let signedIn = record.kind === "subscription";
			if (signedIn) {
				if (record.rejectedAt) return { refused: "sign-in-ended" };
				// The pair as the sign-in has it now, held unsaved or stored, which a refusal of its
				// access token makes due and a renewal replaces.
				let pair = this.#unsaved.get(connection(record))?.tokens ?? await this.#tokens(record);
				if (!pair) return { refused: "not-connected" };
				if (pair.access !== current.secret || pair.expires !== current.expiresAt) {
					reread = true;
					continue;
				}
			}
			let enter = prepare(current);
			if (this.#storage.aiPlaceholders.cutoffs() !== cutoffs) continue;
			// A sign-in's pair that changed while it was read is taken again, renewed when it is due.
			if (signedIn && this.#pairs !== pairs) {
				reread = true;
				continue;
			}
			if (signal?.aborted) return { refused: "cancelled" };
			if (!this.#writer()) return { refused: "restarting" };
			let now = this.#clock();
			// A launch whose end was asked meanwhile, its run's or session's or its replacement's, is
			// over from that moment, before storage has the end.
			if (this.#ending.has(found.launchId) || now >= found.expiresAt) {
				return { refused: "launch-ended" };
			}
			// A sign-in's pair is the one just read, so this is its expiry on the launch's clock reading.
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
		if (record.kind === "subscription") {
			let renewed = record.rejectedAt ? "ended" : await this.#signedIn(record, fresh);
			if (renewed === "ended") return { refused: "sign-in-ended" };
			if (renewed === "unavailable") return { refused: "renew-unavailable" };
			if (!renewed) return { refused: "not-connected" };
			return { placeholder: found, record, secret: renewed.access, expiresAt: renewed.expires };
		}
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
			// A GitHub token Copilot's model API takes itself goes with the integration Copilot's CLI is.
			...(copilot.raw ? { headers: COPILOT_RAW_TOKEN_HEADERS } : {}),
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

	/**
	 * Whether a launch is live: its machine not revoked, its document not archived, and what it is
	 * for (its run or session) not ended.
	 */
	async #launchLive(placeholder: AiPlaceholder): Promise<boolean> {
		let [machine, channel, owned] = await Promise.all([
			placeholder.machineId ? this.#storage.machines.get(placeholder.machineId) : undefined,
			placeholder.channelId ? this.#storage.channels.get(placeholder.channelId) : undefined,
			placeholder.owner ? this.#ownerLive(placeholder) : true,
		]);
		if (placeholder.machineId && (!machine || machine.revokedAt)) return false;
		if (placeholder.channelId && (!channel || channel.archivedAt)) return false;
		return owned;
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

	/** A sign-in's tokens as last renewed, or as it was connected; undefined when they don't decrypt. */
	async #tokens(record: AiCredentialRecord): Promise<SubscriptionTokens | undefined> {
		let sealed = record.tokens ?? record.ciphertext;
		if (!sealed) return undefined;
		try {
			let opened = await decrypted(await this.#key, aad(record.userId, record.provider), sealed);
			let tokens = (opened as { tokens?: Partial<SubscriptionTokens> }).tokens;
			return tokens && typeof tokens.access === "string" && typeof tokens.refresh === "string"
					&& typeof tokens.expires === "number"
				? tokens as SubscriptionTokens
				: undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * A sign-in's tokens to send now: as they are while the access token has not reached its renewal
	 * time and the provider has not refused it, else renewed first (always when `renew`, unless they
	 * were renewed since `record` was read). Renewals of one connection run one after another, each
	 * from the pair stored when it starts, so a rotated refresh token is never presented twice. `ended`
	 * once the provider refused to renew the latest pair for good, which marks the sign-in as needing
	 * signing in again and tells its person's lasting launches; `unavailable` when it couldn't be
	 * renewed now, or this process no longer holds the writer lease; undefined when the tokens don't
	 * decrypt or the connection changed meanwhile. An expired access token is never returned.
	 */
	async #signedIn(record: AiCredentialRecord, renew: boolean): Promise<Renewed> {
		let identity = connection(record);
		let tokens = this.#unsaved.get(identity)?.tokens ?? await this.#tokens(record);
		if (!tokens) return undefined;
		if (!renew && !this.#unsaved.has(identity) && this.#current(tokens)) return tokens;
		let seen = renew ? tokens.access : undefined;
		return this.#serially(identity, () => this.#renew(record, identity, seen));
	}

	/** Whether `tokens` may be sent as they are: not past their renewal time, which a refusal ends. */
	#current(tokens: SubscriptionTokens): boolean {
		return this.#clock().getTime() < tokens.expires;
	}

	/**
	 * Makes the pair whose access token is `refused` due for renewal, stored with that very pair so no
	 * process, this one after a restart included, sends the token again. A refusal of a token renewed
	 * past since, however late it arrives, marks nothing: the pair the connection has now is not the
	 * one refused. A mark storage couldn't take is kept for the connection, as a renewed pair is.
	 */
	async #due(record: AiCredentialRecord, identity: string, refused: string): Promise<void> {
		let current = await this.#record(record.userId, record.provider);
		if (!current || connection(current) !== identity || current.rejectedAt) return;
		let tokens = this.#unsaved.get(identity)?.tokens ?? await this.#tokens(current);
		if (!tokens || tokens.access !== refused || !this.#current(tokens)) return;
		let due = { ...tokens, expires: 0 };
		let pending: UnsavedTokens = {
			tokens: due,
			sealed: await encrypted(await this.#key, aad(record.userId, record.provider), {
				tokens: due,
			}),
		};
		this.#hold(identity, pending);
		await this.#save(current, identity, pending);
	}

	/**
	 * Runs `work` once all work queued before it under `key` has settled: a connection's renewals,
	 * by connection, and a person's sign-in saves and disconnects, by person and provider.
	 */
	#serially<T>(key: string, work: () => Promise<T>): Promise<T> {
		let before = this.#renewing.get(key) ?? Promise.resolve();
		let result = before.then(work);
		let settled = result.then(() => undefined, () => undefined);
		this.#renewing.set(key, settled);
		void settled.then(() => {
			if (this.#renewing.get(key) === settled) this.#renewing.delete(key);
		});
		return result;
	}

	/**
	 * Renews a sign-in from the pair it has now, read again here: a pair renewed since its caller read
	 * it is returned as it is while it may be sent, and one refused for good marks the very stored pair
	 * it was, never a newer one. A renewed pair storage couldn't take is kept for the connection and
	 * saved by its next use, so the spent refresh token is never sent again.
	 */
	async #renew(record: AiCredentialRecord, identity: string, seen?: string): Promise<Renewed> {
		let current = await this.#record(record.userId, record.provider);
		if (!current || connection(current) !== identity) {
			this.#forget(identity);
			return undefined;
		}
		if (current.rejectedAt) return "ended";
		let unsaved = this.#unsaved.get(identity);
		if (unsaved) {
			let saved = await this.#save(current, identity, unsaved);
			if (saved === "lost") return undefined;
			if (saved === "saved") current = { ...current, tokens: unsaved.sealed };
		}
		let tokens = unsaved?.tokens ?? await this.#tokens(current);
		if (!tokens) return undefined;
		if (seen !== tokens.access && this.#current(tokens)) return tokens;
		if (!this.#writer()) return "unavailable";
		let renewed: SubscriptionTokens;
		try {
			renewed = await refreshSignIn(record.provider as SubscriptionProvider, tokens, {
				fetch: this.#fetch,
				now: () => this.#clock().getTime(),
				endpoints: this.#signInEndpoints,
			});
		} catch (err) {
			if (!(err instanceof RefreshRefused)) return "unavailable";
			this.#forget(identity);
			if (await this.#storage.aiCredentials.rejected(current, this.#clock())) {
				this.#told(record.userId);
			}
			return "ended";
		}
		let pending: UnsavedTokens = {
			tokens: renewed,
			sealed: await encrypted(await this.#key, aad(record.userId, record.provider), {
				tokens: renewed,
			}),
		};
		this.#hold(identity, pending);
		return await this.#save(current, identity, pending) === "lost" ? undefined : renewed;
	}

	/**
	 * Saves a renewed pair over the stored pair `current` holds: `lost` when the connection changed
	 * meanwhile, so the pair is no longer its, and `kept` for the next try when storage couldn't take it.
	 */
	async #save(
		current: AiCredentialRecord,
		identity: string,
		pending: UnsavedTokens,
	): Promise<"saved" | "kept" | "lost"> {
		let saved: boolean;
		try {
			saved = await this.#storage.aiCredentials.refreshed(this.#lease(), current, pending.sealed);
		} catch (err) {
			console.warn("[ai] couldn't save a sign-in's renewed tokens; kept to save again", err);
			return "kept";
		} finally {
			this.#pairs++;
		}
		if (this.#unsaved.get(identity) === pending) this.#unsaved.delete(identity);
		return saved ? "saved" : "lost";
	}

	/** Holds `pending` as the pair a sign-in's connection has now, until storage takes it. */
	#hold(identity: string, pending: UnsavedTokens): void {
		this.#unsaved.set(identity, pending);
		this.#pairs++;
	}

	/** Drops the pair this process holds for a sign-in's connection that storage hasn't taken yet. */
	#forget(identity: string): void {
		if (this.#unsaved.delete(identity)) this.#pairs++;
	}

	/** Drops what this process holds for every connection of a person's provider but `kept`. */
	#forgetReplaced(userId: string, provider: AiProvider, kept?: string): void {
		let prefix = `${userId}\n${provider}\n`;
		for (let identity of this.#unsaved.keys()) {
			if (identity.startsWith(prefix) && identity !== kept) this.#forget(identity);
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
	 * asked (`since`). GitHub saying the account has no Copilot subscription is `none`, not an error;
	 * a token Chopin can't read, a question GitHub couldn't answer, or a token neither GitHub's
	 * exchange nor Copilot's model API takes (see `copilotTokenExchange`) is `unknown`, which no
	 * record keeps.
	 */
	async #copilotAccess(
		record: AiCredentialRecord,
		githubToken: string | undefined,
		fresh = false,
	): Promise<CopilotAnswer> {
		let since = this.#completed;
		if (!githubToken) return { access: "unknown", since };
		let account = copilotAccount(record, githubToken);
		this.#answersFor(account, record.userId);
		try {
			let answer = await this.#copilotAnswer(account, githubToken, fresh);
			return answer.token
				? { account, access: "access", since: answer.since, expiresAt: answer.token.expiresAt }
				: { account, access: "none", since: answer.since };
		} catch {
			return { account, access: "unknown", since };
		}
	}

	async #copilotToken(
		record: AiCredentialRecord,
		githubToken: string,
		fresh = false,
	): Promise<CopilotToken | undefined> {
		let account = copilotAccount(record, githubToken);
		this.#answersFor(account, record.userId);
		return (await this.#copilotAnswer(account, githubToken, fresh)).token;
	}

	/** Remembers that `account`'s answers about Copilot access are `userId`'s, to tell them of one. */
	#answersFor(account: string, userId: string): void {
		let users = this.#accountUsers.get(account);
		if (users) users.add(userId);
		else this.#accountUsers.set(account, new Set([userId]));
	}

	/**
	 * The Copilot token GitHub gives `githubToken`, asked once for every caller at a time and held
	 * until a minute before it expires, or five minutes at most, so a seat GitHub removes is noticed,
	 * with how many answers had completed when it was asked. A question is shared, and an answer
	 * used again, only for the same token and the same account (see `copilotAccount`): a sign-in never
	 * takes what was answered for the same token connected instead, which isn't ordered with its own
	 * answers. GitHub saying the account has no Copilot subscription is held as long; a failure, any
	 * other refusal among them, is not held. A token that has expired by the time a caller has it, one
	 * GitHub gave already expired or one that expired while GitHub answered, is a failure: it is never
	 * returned.
	 */
	async #copilotAnswer(
		account: string,
		githubToken: string,
		fresh = false,
	): Promise<{ token: CopilotToken | undefined; since: number }> {
		let key = `${account} ${Buffer.from(digest(githubToken)).toString("hex")}`;
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
	 * account (the other completed after this one was asked) may have been decided first: neither is
	 * settled from then on, and GitHub is asked again, at most `ANSWER_ATTEMPTS` times, after which it
	 * is a failure, like one GitHub couldn't give.
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
				// A token already expired is no answer, as every caller takes it.
				let answer = !token || token.expiresAt > this.#clock().getTime();
				if (this.#crossed(entry, access)) {
					if (answer) this.#answered(entry, access, false);
					continue;
				}
				if (token) entry.until = Math.min(entry.until, token.expiresAt - RENEW_BEFORE_MS);
				if (answer) this.#answered(entry, access);
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
	 * tokens asked: the next question about it asks GitHub again. Another account, a token connected
	 * instead of the sign-in, keeps its own. An answer `kept` settles the account on it; one that
	 * crossed an answer of the other kind settles nothing and disputes what the account was settled
	 * on, if it says otherwise, so neither is used until GitHub answers a question put after it.
	 */
	#answered(entry: HeldAnswer, access: "access" | "none", kept = true): void {
		let latest = this.#answers.get(entry.account) ?? { access: 0, none: 0 };
		let before = latest.settled;
		latest[access] = ++this.#completed;
		this.#answers.set(entry.account, latest);
		for (let [key, other] of this.#copilotTokens) {
			if (other.account === entry.account && other.access && other.access !== access) {
				this.#copilotTokens.delete(key);
			}
		}
		if (!kept) {
			if (before && before !== access) latest.settled = "disputed";
			return;
		}
		entry.access = access;
		latest.settled = access;
		// A seat GitHub confirms lost or regained, or confirms either way once it was disputed, changes
		// what its people's launches may be given: their launches that last are told, as for a provider
		// they connect or remove. The same answer again, and a question GitHub couldn't answer (a rate
		// limit among them), tell no one.
		if (before && before !== access) {
			for (let userId of this.#accountUsers.get(entry.account) ?? []) this.#told(userId);
		}
	}
}
