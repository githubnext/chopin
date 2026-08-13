import { createHash, timingSafeEqual } from "node:crypto";

import type { StorageAdapter } from "../storage/port";
import type { UserRecord, WebSession } from "../storage/model";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ATTEMPT_TTL_MS = 10 * 60 * 1_000;
const CIPHER_VERSION = 1;
const NONCE_BYTES = 12;
const SECRET_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Clock = () => Date;

type OAuthPlaintext = {
	v: 1;
	token: string;
};

export type AuthenticatedSession = {
	session: WebSession;
	user: UserRecord;
	oauthToken: string;
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

function oauth(value: unknown): OAuthPlaintext | undefined {
	if (!value || typeof value !== "object") return undefined;
	let record = value as Record<string, unknown>;
	if (record.v !== 1 || typeof record.token !== "string" || !record.token) return undefined;
	return { v: 1, token: record.token };
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
	readonly cookieName: string;

	constructor(
		storage: StorageAdapter,
		key: Uint8Array,
		secure: boolean,
		clock: Clock = () => new Date(),
	) {
		this.#storage = storage;
		this.#key = imported(key);
		this.#secure = secure;
		this.#clock = clock;
		this.cookieName = secure ? "__Host-chopin_session" : "chopin_session";
	}

	async issue(userId: string, oauthToken: string): Promise<IssuedSession> {
		let id = crypto.randomUUID();
		let secret = random(SECRET_BYTES);
		let createdAt = this.#clock();
		let expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
		let token = await encrypted(
			await this.#key,
			`chopin:web-session:v1:${id}:${userId}`,
			{ v: 1, token: oauthToken } satisfies OAuthPlaintext,
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
		let user = await this.#storage.users.get(stored.userId);
		if (!user) return undefined;
		try {
			let plaintext = oauth(
				await decrypted(
					await this.#key,
					`chopin:web-session:v1:${stored.id}:${stored.userId}`,
					stored.oauthToken,
				),
			);
			if (!plaintext) return undefined;
			return { session: stored, user, oauthToken: plaintext.token };
		} catch {
			return undefined;
		}
	}

	async revoke(request: Request): Promise<void> {
		let parsed = this.#parse(request);
		if (!parsed) return;
		let stored = await this.#storage.sessions.get(parsed.id, this.#clock());
		if (stored && equal(hash(parsed.secret), stored.secretHash)) {
			await this.#storage.sessions.delete(stored.id);
		}
	}

	clearCookie(): string {
		return cleared(this.cookieName, this.#secure);
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
