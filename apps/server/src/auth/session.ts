import { createHash, timingSafeEqual } from "node:crypto";

import { GitHubError, GitHubTokenError } from "../github/client";

import type { GitHubTokenGrant } from "../github/client";
import type { StorageAdapter } from "../storage/port";
import type { UserRecord, WebSession } from "../storage/model";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ATTEMPT_TTL_MS = 10 * 60 * 1_000;
const REFRESH_EARLY_MS = 5 * 60 * 1_000;
const CIPHER_VERSION = 1;
const NONCE_BYTES = 12;
const SECRET_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Clock = () => Date;

type CredentialPlaintext = {
	v: 2;
	accessToken: string;
	accessExpiresAt: string;
	refreshToken: string;
	refreshExpiresAt: string;
	revision: number;
};

export type SessionAccess = {
	token: string;
	expiresAt: Date;
	revision: number;
};

export type AuthenticatedSession = {
	session: WebSession;
	user: UserRecord;
	access: SessionAccess;
};

export type IssuedSession = {
	id: string;
	cookie: string;
	expiresAt: Date;
};

export type OAuthAttempt = {
	state: string;
	verifier: string;
	challenge: string;
	cookie: string;
	expiresAt: Date;
};

type StoredAttempt = {
	v: 1;
	state: string;
	verifier: string;
	expiresAt: string;
};

type CredentialState = {
	stored: WebSession;
	access: SessionAccess;
	refreshToken: string;
	refreshExpiresAt: Date;
};

type SessionOptions = {
	refresh?: (refreshToken: string) => Promise<GitHubTokenGrant>;
	beforeRefresh?: (sessionId: string, revision: number) => Promise<void>;
	onRevoked?: (sessionId: string) => Promise<void>;
	invalidate?: (accessToken: string) => void;
};

type Rejection = "deleted" | "changed" | "missing";

function random(bytes: number): Uint8Array {
	let value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return value;
}

function base64(value: Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

function decoded(value: string): Uint8Array | undefined {
	if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
	try {
		let bytes = new Uint8Array(Buffer.from(value, "base64url"));
		return bytes.length > 0 && base64(bytes) === value ? bytes : undefined;
	} catch {
		return undefined;
	}
}

function hash(value: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(value).digest());
}

function buffer(value: Uint8Array): ArrayBuffer {
	return value.slice().buffer as ArrayBuffer;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && timingSafeEqual(left, right);
}

function values(request: Request, name: string): string[] {
	let header = request.headers.get("cookie");
	if (!header) return [];
	let found: string[] = [];
	for (let part of header.split(";")) {
		let separator = part.indexOf("=");
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		found.push(part.slice(separator + 1).trim());
	}
	return found;
}

function serialized(
	name: string,
	value: string,
	expiresAt: Date,
	secure: boolean,
	path = "/",
	maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000)),
): string {
	let attributes = [
		`${name}=${value}`,
		`Path=${path}`,
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${maxAge}`,
		`Expires=${expiresAt.toUTCString()}`,
	];
	if (secure) attributes.push("Secure");
	return attributes.join("; ");
}

function cleared(name: string, secure: boolean, path = "/"): string {
	return serialized(name, "", new Date(0), secure, path, 0);
}

async function imported(value: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", buffer(value), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypted(key: CryptoKey, aad: string, plaintext: unknown): Promise<Uint8Array> {
	let nonce = random(NONCE_BYTES);
	let content = encoder.encode(JSON.stringify(plaintext));
	let ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: buffer(nonce), additionalData: buffer(encoder.encode(aad)) },
		key,
		buffer(content),
	);
	let envelope = new Uint8Array(1 + NONCE_BYTES + ciphertext.byteLength);
	envelope[0] = CIPHER_VERSION;
	envelope.set(nonce, 1);
	envelope.set(new Uint8Array(ciphertext), 1 + NONCE_BYTES);
	return envelope;
}

async function decrypted(key: CryptoKey, aad: string, envelope: Uint8Array): Promise<unknown> {
	if (envelope.length <= 1 + NONCE_BYTES || envelope[0] !== CIPHER_VERSION) {
		throw new Error("bad envelope");
	}
	let nonce = envelope.slice(1, 1 + NONCE_BYTES);
	let ciphertext = envelope.slice(1 + NONCE_BYTES);
	let plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: buffer(nonce), additionalData: buffer(encoder.encode(aad)) },
		key,
		buffer(ciphertext),
	);
	return JSON.parse(decoder.decode(plaintext));
}

function credentials(value: unknown): Omit<CredentialState, "stored"> | undefined {
	if (!value || typeof value !== "object") return undefined;
	let record = value as Record<string, unknown>;
	if (
		record.v !== 2
		|| typeof record.accessToken !== "string"
		|| !record.accessToken
		|| typeof record.accessExpiresAt !== "string"
		|| typeof record.refreshToken !== "string"
		|| !record.refreshToken
		|| typeof record.refreshExpiresAt !== "string"
		|| !Number.isSafeInteger(record.revision)
		|| (record.revision as number) < 1
	) return undefined;
	let accessExpiresAt = new Date(record.accessExpiresAt);
	let refreshExpiresAt = new Date(record.refreshExpiresAt);
	if (Number.isNaN(accessExpiresAt.getTime()) || Number.isNaN(refreshExpiresAt.getTime())) {
		return undefined;
	}
	return {
		access: {
			token: record.accessToken,
			expiresAt: accessExpiresAt,
			revision: record.revision as number,
		},
		refreshToken: record.refreshToken,
		refreshExpiresAt,
	};
}

function attempt(value: unknown): StoredAttempt | undefined {
	if (!value || typeof value !== "object") return undefined;
	let record = value as Record<string, unknown>;
	if (
		record.v !== 1
		|| typeof record.state !== "string"
		|| typeof record.verifier !== "string"
		|| typeof record.expiresAt !== "string"
	) return undefined;
	return { v: 1, state: record.state, verifier: record.verifier, expiresAt: record.expiresAt };
}

/** Durable login sessions: only a secret hash and OAuth ciphertext reach storage. */
export class Sessions {
	readonly #storage: StorageAdapter;
	readonly #key: Promise<CryptoKey>;
	readonly #secure: boolean;
	readonly #clock: Clock;
	readonly #options: SessionOptions;
	readonly #refreshes = new Map<string, Promise<CredentialState | undefined>>();
	readonly cookieName: string;

	constructor(
		storage: StorageAdapter,
		key: Uint8Array,
		secure: boolean,
		clock: Clock = () => new Date(),
		options: SessionOptions = {},
	) {
		this.#storage = storage;
		this.#key = imported(key);
		this.#secure = secure;
		this.#clock = clock;
		this.#options = options;
		this.cookieName = secure ? "__Host-chopin_session" : "chopin_session";
	}

	async issue(userId: string, grant: GitHubTokenGrant): Promise<IssuedSession> {
		let id = crypto.randomUUID();
		let secret = random(SECRET_BYTES);
		let createdAt = this.#clock();
		let expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
		let token = await encrypted(
			await this.#key,
			`chopin:web-session:v2:${id}:${userId}`,
			this.#plaintext(grant, createdAt, 1),
		);
		await this.#storage.sessions.create({
			id,
			userId,
			secretHash: hash(secret),
			oauthToken: token,
			expiresAt,
			createdAt,
		});
		return {
			id,
			cookie: serialized(
				this.cookieName,
				`${id}.${base64(secret)}`,
				expiresAt,
				this.#secure,
				"/",
				SESSION_TTL_MS / 1_000,
			),
			expiresAt,
		};
	}

	async authenticate(request: Request): Promise<AuthenticatedSession | undefined> {
		let parsed = this.#parse(request);
		if (!parsed) return undefined;
		let stored = await this.#storage.sessions.get(parsed.id, this.#clock());
		if (!stored || !equal(hash(parsed.secret), stored.secretHash)) return undefined;
		return this.#resolve(stored);
	}

	/** Resolve an already-authorized internal owner without exposing ciphertext handling. */
	async resolve(id: string): Promise<AuthenticatedSession | undefined> {
		let stored = await this.#storage.sessions.get(id, this.#clock());
		return stored ? this.#resolve(stored) : undefined;
	}

	/** Read current credentials without triggering rotation from inside an active agent callback. */
	async inspect(id: string): Promise<AuthenticatedSession | undefined> {
		let stored = await this.#storage.sessions.get(id, this.#clock());
		if (!stored) return undefined;
		let current = await this.#decrypt(stored);
		if (!current || current.access.expiresAt <= this.#clock()) return undefined;
		let user = await this.#storage.users.get(stored.userId);
		return user ? { session: stored, user, access: current.access } : undefined;
	}

	/** Run one idempotent GitHub read, refreshing and retrying once after a 401. */
	async use<T>(
		authenticated: AuthenticatedSession,
		operation: (token: string) => Promise<T>,
	): Promise<{ value: T; authenticated: AuthenticatedSession }> {
		try {
			return {
				value: await operation(authenticated.access.token),
				authenticated,
			};
		} catch (err) {
			if (!(err instanceof GitHubError) || err.status !== 401) throw err;
		}
		let refreshed = await this.#refresh(authenticated.session.id, authenticated.access.revision);
		if (!refreshed) throw new GitHubError("GitHub authorization expired", 401);
		try {
			return { value: await operation(refreshed.access.token), authenticated: refreshed };
		} catch (err) {
			if (!(err instanceof GitHubError) || err.status !== 401) throw err;
			let rejected = await this.#reject(refreshed.session, refreshed.access.revision);
			if (rejected === "changed") {
				throw new GitHubError("GitHub credentials changed; retry the request", 503);
			}
			throw new GitHubError("GitHub authorization expired", 401);
		}
	}

	async #resolve(stored: WebSession): Promise<AuthenticatedSession | undefined> {
		let current = await this.#fresh(stored);
		if (!current) return undefined;
		let user = await this.#storage.users.get(stored.userId);
		if (!user) return undefined;
		return { session: current.stored, user, access: current.access };
	}

	async #fresh(stored: WebSession): Promise<CredentialState | undefined> {
		let current = await this.#decrypt(stored);
		if (!current) return undefined;
		if (current.access.expiresAt.getTime() > this.#clock().getTime() + REFRESH_EARLY_MS) {
			return current;
		}
		return this.#rotate(stored.id, undefined);
	}

	async #refresh(id: string, rejectedRevision: number): Promise<AuthenticatedSession | undefined> {
		let current = await this.#rotate(id, rejectedRevision);
		if (!current) return undefined;
		let user = await this.#storage.users.get(current.stored.userId);
		return user ? { session: current.stored, user, access: current.access } : undefined;
	}

	async #rotate(
		id: string,
		rejectedRevision: number | undefined,
	): Promise<CredentialState | undefined> {
		let active = this.#refreshes.get(id);
		if (active) {
			let result = await active;
			if (
				rejectedRevision === undefined
				|| !result
				|| result.access.revision !== rejectedRevision
			) return result;
			if (this.#refreshes.get(id) === active) this.#refreshes.delete(id);
			return this.#rotate(id, rejectedRevision);
		}
		let refresh = this.#rotateOnce(id, rejectedRevision);
		this.#refreshes.set(id, refresh);
		void refresh.finally(() => {
			if (this.#refreshes.get(id) === refresh) this.#refreshes.delete(id);
		}).catch(() => {});
		return refresh;
	}

	async #rotateOnce(
		id: string,
		rejectedRevision: number | undefined,
	): Promise<CredentialState | undefined> {
		let now = this.#clock();
		let stored = await this.#storage.sessions.get(id, now);
		if (!stored) return undefined;
		let current = await this.#decrypt(stored);
		if (!current) return undefined;
		if (rejectedRevision !== undefined && current.access.revision !== rejectedRevision) {
			return current;
		}
		if (
			rejectedRevision === undefined
			&& current.access.expiresAt.getTime() > now.getTime() + REFRESH_EARLY_MS
		) return current;
		if (current.refreshExpiresAt <= now) {
			return this.#deleteOrReload(current);
		}
		let refresh = this.#options.refresh;
		if (!refresh) {
			if (current.access.expiresAt > now && rejectedRevision === undefined) return current;
			throw new GitHubTokenError("GitHub token refresh is not configured");
		}
		try {
			await this.#options.beforeRefresh?.(id, current.access.revision);
			let grant = await refresh(current.refreshToken);
			let replacement = await encrypted(
				await this.#key,
				`chopin:web-session:v2:${stored.id}:${stored.userId}`,
				this.#plaintext(grant, this.#clock(), current.access.revision + 1),
			);
			let changed = await this.#storage.sessions.replaceToken(
				stored.id,
				stored.oauthToken,
				replacement,
				this.#clock(),
			);
			if (!changed) {
				let latest = await this.#storage.sessions.get(stored.id, this.#clock());
				return latest ? this.#decrypt(latest) : undefined;
			}
			this.#options.invalidate?.(current.access.token);
			let latest = { ...stored, oauthToken: replacement };
			return this.#decrypt(latest);
		} catch (err) {
			if (err instanceof GitHubTokenError && err.terminal) {
				return this.#deleteOrReload(current);
			}
			if (rejectedRevision === undefined && current.access.expiresAt > this.#clock()) {
				return current;
			}
			throw err;
		}
	}

	async #decrypt(stored: WebSession): Promise<CredentialState | undefined> {
		try {
			let parsed = credentials(
				await decrypted(
					await this.#key,
					`chopin:web-session:v2:${stored.id}:${stored.userId}`,
					stored.oauthToken,
				),
			);
			return parsed ? { stored, ...parsed } : undefined;
		} catch {
			return undefined;
		}
	}

	#plaintext(grant: GitHubTokenGrant, now: Date, revision: number): CredentialPlaintext {
		return {
			v: 2,
			accessToken: grant.accessToken,
			accessExpiresAt: new Date(now.getTime() + grant.accessExpiresIn * 1_000).toISOString(),
			refreshToken: grant.refreshToken,
			refreshExpiresAt: new Date(now.getTime() + grant.refreshExpiresIn * 1_000).toISOString(),
			revision,
		};
	}

	async #reject(stored: WebSession, revision: number): Promise<Rejection> {
		let current = await this.#decrypt(stored);
		if (!current || current.access.revision !== revision) return "changed";
		if (await this.#deleteCurrent(current)) return "deleted";
		return await this.#storage.sessions.get(stored.id, this.#clock()) ? "changed" : "missing";
	}

	async #deleteOrReload(current: CredentialState): Promise<CredentialState | undefined> {
		if (await this.#deleteCurrent(current)) return undefined;
		let latest = await this.#storage.sessions.get(current.stored.id, this.#clock());
		return latest ? this.#decrypt(latest) : undefined;
	}

	async #deleteCurrent(current: CredentialState): Promise<boolean> {
		let deleted = await this.#storage.sessions.deleteToken(
			current.stored.id,
			current.stored.oauthToken,
			this.#clock(),
		);
		if (deleted) {
			this.#options.invalidate?.(current.access.token);
			await this.#options.onRevoked?.(current.stored.id);
		}
		return deleted;
	}

	async revoke(request: Request): Promise<string | undefined> {
		let parsed = this.#parse(request);
		if (!parsed) return undefined;
		let stored = await this.#storage.sessions.get(parsed.id, this.#clock());
		if (stored && equal(hash(parsed.secret), stored.secretHash)) {
			let current = await this.#decrypt(stored);
			let deleted = await this.#storage.sessions.delete(stored.id);
			if (deleted) {
				if (current) this.#options.invalidate?.(current.access.token);
				await this.#options.onRevoked?.(stored.id);
			}
			return stored.id;
		}
		return undefined;
	}

	clearCookie(): string {
		return cleared(this.cookieName, this.#secure);
	}

	/** The one credential needed to revalidate an already-open hosted socket. */
	credential(request: Request): string | undefined {
		let cookies = values(request, this.cookieName);
		return cookies.length === 1 && this.#parse(request)
			? `${this.cookieName}=${cookies[0]}`
			: undefined;
	}

	#parse(request: Request): { id: string; secret: Uint8Array } | undefined {
		let cookies = values(request, this.cookieName);
		if (cookies.length !== 1) return undefined;
		let separator = cookies[0]!.indexOf(".");
		if (separator < 1) return undefined;
		let id = cookies[0]!.slice(0, separator);
		let secret = decoded(cookies[0]!.slice(separator + 1));
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
			|| !secret
			|| secret.length !== SECRET_BYTES
		) return undefined;
		return { id, secret };
	}
}

/** Short-lived encrypted OAuth state and PKCE verifier carried only by the browser. */
export class OAuthAttempts {
	readonly #key: Promise<CryptoKey>;
	readonly #secure: boolean;
	readonly #clock: Clock;
	readonly cookieName: string;

	constructor(key: Uint8Array, secure: boolean, clock: Clock = () => new Date()) {
		this.#key = imported(key);
		this.#secure = secure;
		this.#clock = clock;
		this.cookieName = secure ? "__Host-chopin_oauth_state" : "chopin_oauth_state";
	}

	async issue(): Promise<OAuthAttempt> {
		let state = base64(random(SECRET_BYTES));
		let verifier = base64(random(SECRET_BYTES));
		let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
		let expiresAt = new Date(this.#clock().getTime() + ATTEMPT_TTL_MS);
		let envelope = await encrypted(
			await this.#key,
			"chopin:oauth-state:v1",
			{
				v: 1,
				state,
				verifier,
				expiresAt: expiresAt.toISOString(),
			} satisfies StoredAttempt,
		);
		return {
			state,
			verifier,
			challenge: base64(digest),
			cookie: serialized(
				this.cookieName,
				base64(envelope),
				expiresAt,
				this.#secure,
				"/",
				ATTEMPT_TTL_MS / 1_000,
			),
			expiresAt,
		};
	}

	async read(request: Request): Promise<StoredAttempt | undefined> {
		let cookies = values(request, this.cookieName);
		if (cookies.length !== 1) return undefined;
		let envelope = decoded(cookies[0]!);
		if (!envelope) return undefined;
		try {
			let stored = attempt(await decrypted(await this.#key, "chopin:oauth-state:v1", envelope));
			if (!stored) return undefined;
			let expiresAt = new Date(stored.expiresAt);
			if (Number.isNaN(expiresAt.getTime()) || expiresAt <= this.#clock()) return undefined;
			return stored;
		} catch {
			return undefined;
		}
	}

	clearCookie(): string {
		return cleared(this.cookieName, this.#secure);
	}
}
