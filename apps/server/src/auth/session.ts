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

type MemorySession = {
	session: WebSession;
	user: UserRecord;
	secretHash: Uint8Array;
	accessToken: string;
	accessExpiresAt: Date;
	refreshToken: string;
	refreshExpiresAt: Date;
	revision: number;
};

type SessionOptions = {
	refresh?: (refreshToken: string) => Promise<GitHubTokenGrant>;
	authorize?: (user: UserRecord, accessToken: string) => Promise<boolean>;
	beforeRefresh?: (sessionId: string, revision: number) => Promise<void>;
	onRevoked?: (sessionId: string) => Promise<void>;
	invalidate?: (accessToken: string) => void;
};

type Rejection = "revoked" | "changed" | "missing";

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

/** Process-local browser and GitHub credentials backed by a token-free ownership registry. */
export class Sessions {
	readonly #storage: StorageAdapter;
	readonly #secure: boolean;
	readonly #clock: Clock;
	readonly #options: SessionOptions;
	readonly #sessions = new Map<string, MemorySession>();
	readonly #refreshes = new Map<string, Promise<MemorySession | undefined>>();
	readonly #revocations = new Map<string, Promise<boolean>>();
	readonly #pendingDeletes = new Set<string>();
	readonly cookieName: string;

	constructor(
		storage: StorageAdapter,
		secure: boolean,
		clock: Clock = () => new Date(),
		options: SessionOptions = {},
	) {
		this.#storage = storage;
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
		let user = await this.#storage.users.get(userId);
		if (!user) throw new Error("cannot create a session for a missing user");
		let session = { id, userId, expiresAt, createdAt };
		await this.#storage.sessions.create(session);
		this.#sessions.set(id, this.#fromGrant(session, user, hash(secret), grant, 1, createdAt));
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
		let current = this.#sessions.get(parsed.id);
		if (
			!current
			|| current.session.expiresAt <= this.#clock()
			|| !equal(hash(parsed.secret), current.secretHash)
		) return undefined;
		return this.#resolve(current);
	}

	/** Resolve an already-authorized internal owner from this process. */
	async resolve(id: string): Promise<AuthenticatedSession | undefined> {
		let current = this.#sessions.get(id);
		return current && current.session.expiresAt > this.#clock()
			? this.#resolve(current)
			: undefined;
	}

	/** Read current credentials without triggering rotation from inside an active agent callback. */
	async inspect(id: string): Promise<AuthenticatedSession | undefined> {
		if (this.#refreshes.has(id) || this.#revocations.has(id)) return undefined;
		let current = this.#sessions.get(id);
		if (
			!current
			|| current.session.expiresAt <= this.#clock()
			|| current.accessExpiresAt <= this.#clock()
		) return undefined;
		return this.#authenticated(current);
	}

	/** Resolve a copied agent credential without yielding before its request starts. */
	token(id: string, revision: number): string | undefined {
		if (this.#refreshes.has(id) || this.#revocations.has(id)) return undefined;
		let current = this.#sessions.get(id);
		return current
				&& current.revision === revision
				&& current.session.expiresAt > this.#clock()
				&& current.accessExpiresAt > this.#clock()
			? current.accessToken
			: undefined;
	}

	/** Run one idempotent GitHub read, refreshing and retrying once after a 401. */
	async use<T>(
		authenticated: AuthenticatedSession,
		operation: (token: string) => Promise<T>,
	): Promise<{ value: T; authenticated: AuthenticatedSession }> {
		let current = this.#current(authenticated);
		if (!current) throw new GitHubError("GitHub authorization expired", 401);
		try {
			return {
				value: await operation(current.accessToken),
				authenticated: this.#authenticated(current),
			};
		} catch (err) {
			if (!(err instanceof GitHubError) || err.status !== 401) throw err;
		}
		let refreshed = await this.#rotate(current.session.id, current.revision);
		if (!refreshed || this.#sessions.get(current.session.id) !== refreshed) {
			throw new GitHubError("GitHub authorization expired", 401);
		}
		try {
			return {
				value: await operation(refreshed.accessToken),
				authenticated: this.#authenticated(refreshed),
			};
		} catch (err) {
			if (!(err instanceof GitHubError) || err.status !== 401) throw err;
			let rejected = await this.#reject(refreshed.session.id, refreshed.revision);
			if (rejected === "changed") {
				throw new GitHubError("GitHub credentials changed; retry the request", 503);
			}
			throw new GitHubError("GitHub authorization expired", 401);
		}
	}

	async #resolve(current: MemorySession): Promise<AuthenticatedSession | undefined> {
		let fresh = await this.#fresh(current);
		if (!fresh) return undefined;
		let authorize = this.#options.authorize;
		if (authorize) {
			let allowed: boolean;
			try {
				allowed = await authorize(fresh.user, fresh.accessToken);
			} catch (err) {
				if (!(err instanceof GitHubError) || err.status !== 401) throw err;
				let refreshed = await this.#rotate(fresh.session.id, fresh.revision);
				if (!refreshed || this.#sessions.get(fresh.session.id) !== refreshed) return undefined;
				fresh = refreshed;
				try {
					allowed = await authorize(fresh.user, fresh.accessToken);
				} catch (retryError) {
					if (!(retryError instanceof GitHubError) || retryError.status !== 401) {
						throw retryError;
					}
					let rejected = await this.#reject(fresh.session.id, fresh.revision);
					if (rejected === "changed") {
						let active = this.#sessions.get(fresh.session.id);
						return active ? this.#resolve(active) : undefined;
					}
					return undefined;
				}
			}
			let active = this.#sessions.get(fresh.session.id);
			if (active !== fresh) return active ? this.#resolve(active) : undefined;
			if (!allowed) {
				await this.#revokeExact(fresh);
				return undefined;
			}
		}
		return this.#sessions.get(fresh.session.id) === fresh
			? this.#authenticated(fresh)
			: undefined;
	}

	async #fresh(current: MemorySession): Promise<MemorySession | undefined> {
		if (current.session.expiresAt <= this.#clock()) {
			await this.#revokeExact(current);
			return undefined;
		}
		if (current.accessExpiresAt.getTime() > this.#clock().getTime() + REFRESH_EARLY_MS) {
			return current;
		}
		return this.#rotate(current.session.id, undefined);
	}

	async #rotate(
		id: string,
		rejectedRevision: number | undefined,
	): Promise<MemorySession | undefined> {
		let active = this.#refreshes.get(id);
		if (active) {
			let result = await active;
			if (
				rejectedRevision === undefined
				|| !result
				|| result.revision !== rejectedRevision
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
	): Promise<MemorySession | undefined> {
		let now = this.#clock();
		let current = this.#sessions.get(id);
		if (!current) return undefined;
		if (current.session.expiresAt <= now) {
			await this.#revokeExact(current);
			return undefined;
		}
		if (rejectedRevision !== undefined && current.revision !== rejectedRevision) {
			return current;
		}
		if (
			rejectedRevision === undefined
			&& current.accessExpiresAt.getTime() > now.getTime() + REFRESH_EARLY_MS
		) return current;
		if (current.refreshExpiresAt <= now) {
			await this.#revokeExact(current);
			return this.#sessions.get(id);
		}
		let refresh = this.#options.refresh;
		if (!refresh) {
			if (current.accessExpiresAt > now && rejectedRevision === undefined) return current;
			throw new GitHubTokenError("GitHub token refresh is not configured");
		}
		try {
			await this.#options.beforeRefresh?.(id, current.revision);
			if (this.#sessions.get(id) !== current) return this.#sessions.get(id);
			let grant = await refresh(current.refreshToken);
			if (this.#sessions.get(id) !== current) return this.#sessions.get(id);
			let refreshedAt = this.#clock();
			if (current.session.expiresAt <= refreshedAt) {
				await this.#revokeExact(current);
				return undefined;
			}
			let replacement = this.#fromGrant(
				current.session,
				current.user,
				current.secretHash,
				grant,
				current.revision + 1,
				refreshedAt,
			);
			this.#sessions.set(id, replacement);
			this.#options.invalidate?.(current.accessToken);
			return replacement;
		} catch (err) {
			if (err instanceof GitHubTokenError && err.terminal) {
				await this.#revokeExact(current);
				return this.#sessions.get(id);
			}
			if (
				rejectedRevision === undefined
				&& this.#sessions.get(id) === current
				&& current.accessExpiresAt > this.#clock()
			) {
				return current;
			}
			throw err;
		}
	}

	#fromGrant(
		session: WebSession,
		user: UserRecord,
		secretHash: Uint8Array,
		grant: GitHubTokenGrant,
		revision: number,
		now: Date,
	): MemorySession {
		return {
			session: {
				...session,
				expiresAt: new Date(session.expiresAt),
				createdAt: new Date(session.createdAt),
			},
			user: {
				...user,
				createdAt: new Date(user.createdAt),
				updatedAt: new Date(user.updatedAt),
			},
			secretHash: new Uint8Array(secretHash),
			accessToken: grant.accessToken,
			accessExpiresAt: new Date(now.getTime() + grant.accessExpiresIn * 1_000),
			refreshToken: grant.refreshToken,
			refreshExpiresAt: new Date(now.getTime() + grant.refreshExpiresIn * 1_000),
			revision,
		};
	}

	#authenticated(current: MemorySession): AuthenticatedSession {
		return {
			session: {
				...current.session,
				expiresAt: new Date(current.session.expiresAt),
				createdAt: new Date(current.session.createdAt),
			},
			user: {
				...current.user,
				createdAt: new Date(current.user.createdAt),
				updatedAt: new Date(current.user.updatedAt),
			},
			access: {
				token: current.accessToken,
				expiresAt: new Date(current.accessExpiresAt),
				revision: current.revision,
			},
		};
	}

	#current(authenticated: AuthenticatedSession): MemorySession | undefined {
		let current = this.#sessions.get(authenticated.session.id);
		return current
				&& current.session.expiresAt > this.#clock()
			? current
			: undefined;
	}

	async #reject(id: string, revision: number): Promise<Rejection> {
		let refreshing = this.#refreshes.get(id);
		if (refreshing) await refreshing.catch(() => {});
		let current = this.#sessions.get(id);
		if (!current) return "missing";
		if (current.revision !== revision) return "changed";
		return this.#revokeExact(current);
	}

	async #revokeExact(current: MemorySession): Promise<Rejection> {
		let id = current.session.id;
		let active = this.#sessions.get(id);
		if (active !== current) return active ? "changed" : "missing";
		this.#sessions.delete(id);
		this.#options.invalidate?.(current.accessToken);
		await this.#deleteRegistry(id);
		return "revoked";
	}

	#deleteRegistry(id: string): Promise<boolean> {
		let existing = this.#revocations.get(id);
		if (existing) return existing;
		let operation = (async () => {
			let callbackError: unknown;
			try {
				await this.#options.onRevoked?.(id);
			} catch (err) {
				callbackError = err;
			}
			let deleted: boolean;
			try {
				deleted = await this.#storage.sessions.delete(id);
				this.#pendingDeletes.delete(id);
			} catch (err) {
				this.#pendingDeletes.add(id);
				throw err;
			}
			if (callbackError) throw callbackError;
			return deleted;
		})();
		this.#revocations.set(id, operation);
		void operation.finally(() => {
			if (this.#revocations.get(id) === operation) this.#revocations.delete(id);
		}).catch(() => {});
		return operation;
	}

	async revoke(request: Request): Promise<string | undefined> {
		let parsed = this.#parse(request);
		if (!parsed) return undefined;
		let current = this.#sessions.get(parsed.id);
		if (!current || !equal(hash(parsed.secret), current.secretHash)) return undefined;
		await this.#revokeExact(current);
		return current.session.id;
	}

	async cleanupExpired(): Promise<number> {
		let now = this.#clock();
		let removed = 0;
		for (let id of this.#pendingDeletes) {
			await this.#storage.sessions.delete(id);
			this.#pendingDeletes.delete(id);
		}
		for (let current of this.#sessions.values()) {
			if (current.session.expiresAt > now) continue;
			if (await this.#revokeExact(current) === "revoked") removed++;
		}
		return removed + await this.#storage.sessions.deleteExpired(now);
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
