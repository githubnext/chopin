import { createHash, randomBytes } from "node:crypto";
import { fail } from "./service";

import type { GitHubTokenGrant } from "../github/client";

/** How long a pairing key works once minted. */
export const PAIRING_KEY_MS = 10 * 60_000;
/**
 * GitHub's authorization of the next machine is held this long at most, so a key minted up to
 * fifteen minutes after it still carries it for its whole life; never past the access token's own
 * expiry.
 */
const AUTHORIZATION_MS = PAIRING_KEY_MS + 15 * 60_000;
/** Keys one person may mint in any window of this length. */
const MINT_WINDOW_MS = 10 * 60_000;
const MINTS_PER_WINDOW = 10;
const KEY = /^chopin_k_[A-Za-z0-9_-]{43}$/;

/** `autoRun`: whether the machine it pairs lets Chopin build and prototype automatically. */
type Key = { userId: string; sessionId: string; expiresAt: number; autoRun: boolean };
type Held = { grant: GitHubTokenGrant; sessionId: string; issuedAt: number; until: number };

function digest(key: string) {
	return createHash("sha256").update(key).digest("base64url");
}

/**
 * Single-use keys with which `chopin connect --key` pairs a machine without a browser. A key is
 * kept only as a hash, belongs to the account and sign-in that minted it, lasts PAIRING_KEY_MS,
 * and is revoked by minting another or by that sign-in ending. Where machines hold their own
 * GitHub authorization, the person authorizes the next machine with GitHub before minting; it is
 * held for that sign-in only, and the key that pairs one spends it.
 * Everything lives in this process, as pending pairings do.
 */
export class PairingKeys {
	#keys = new Map<string, Key>();
	/** Each person's live key, by hash; minting another replaces it. */
	#current = new Map<string, string>();
	#grants = new Map<string, Held>();
	#mints = new Map<string, number[]>();

	constructor(private now: () => number) {}

	/**
	 * Hold GitHub's authorization of a machine for `userId`, given in the browser sign-in
	 * `sessionId`, until a key pairs one with it or that sign-in ends.
	 */
	authorize(userId: string, sessionId: string, grant: GitHubTokenGrant) {
		let issuedAt = this.now();
		let until = issuedAt + Math.min(AUTHORIZATION_MS, grant.accessExpiresIn * 1000);
		this.#grants.set(userId, { grant, sessionId, issuedAt, until });
	}

	/** Whether this sign-in holds an authorization that outlasts a key minted now. */
	authorized(userId: string, sessionId: string) {
		let held = this.#grants.get(userId);
		return !!held && held.sessionId === sessionId && held.until >= this.now() + PAIRING_KEY_MS;
	}

	/** The sign-in `sessionId` ended: the authorization it gave and the key it minted go with it. */
	ended(sessionId: string) {
		for (let [userId, held] of this.#grants) {
			if (held.sessionId === sessionId) this.#grants.delete(userId);
		}
		for (let [hash, key] of this.#keys) {
			if (key.sessionId !== sessionId) continue;
			this.#keys.delete(hash);
			if (this.#current.get(key.userId) === hash) this.#current.delete(key.userId);
		}
	}

	/**
	 * A new key for `userId`, minted in `sessionId`, replacing the one before it. The machine it
	 * pairs has automatic work on only with `autoRun`, chosen in the browser that minted it.
	 */
	mint(userId: string, sessionId: string, autoRun = false) {
		this.sweep();
		let now = this.now();
		let recent = (this.#mints.get(userId) ?? []).filter(time => time > now - MINT_WINDOW_MS);
		if (recent.length >= MINTS_PER_WINDOW) fail("pairing-key-rate-limited");
		this.#mints.set(userId, [...recent, now]);
		let previous = this.#current.get(userId);
		if (previous) this.#keys.delete(previous);
		let key = `chopin_k_${randomBytes(32).toString("base64url")}`;
		let hash = digest(key);
		let expiresAt = now + PAIRING_KEY_MS;
		this.#keys.set(hash, { userId, sessionId, expiresAt, autoRun });
		this.#current.set(userId, hash);
		// The lifetime too, so a browser whose clock differs from this one counts it right.
		return { key, expiresAt, expiresIn: PAIRING_KEY_MS };
	}

	/**
	 * The account a live key belongs to, and the authorization it would carry, without spending
	 * it. Every refusal reads the same, so a key reveals nothing about any account.
	 */
	peek(key: string) {
		let found = KEY.test(key) ? this.#keys.get(digest(key)) : undefined;
		if (!found || found.expiresAt <= this.now()) fail("pairing-key-invalid");
		return { userId: found.userId, grant: this.#grant(found), autoRun: found.autoRun };
	}

	/** Spend a key: refused unless it is still live, so of two at once only one gets through. */
	take(key: string) {
		let { userId, grant, autoRun } = this.peek(key);
		let hash = digest(key);
		this.#keys.delete(hash);
		if (this.#current.get(userId) === hash) this.#current.delete(userId);
		this.#grants.delete(userId);
		return { userId, grant, autoRun };
	}

	/**
	 * The authorization held by the sign-in that minted `key`, its lifetimes counted from now
	 * rather than from when GitHub gave it.
	 */
	#grant(key: Key): GitHubTokenGrant | undefined {
		let held = this.#grants.get(key.userId);
		if (!held || held.sessionId !== key.sessionId || held.until <= this.now()) return undefined;
		let elapsed = Math.ceil((this.now() - held.issuedAt) / 1000);
		return {
			...held.grant,
			accessExpiresIn: Math.max(0, held.grant.accessExpiresIn - elapsed),
			refreshExpiresIn: Math.max(0, held.grant.refreshExpiresIn - elapsed),
		};
	}

	sweep() {
		let now = this.now();
		for (let [hash, key] of this.#keys) {
			if (key.expiresAt > now) continue;
			this.#keys.delete(hash);
			if (this.#current.get(key.userId) === hash) this.#current.delete(key.userId);
		}
		for (let [userId, held] of this.#grants) {
			if (held.until <= now) this.#grants.delete(userId);
		}
		for (let [userId, times] of this.#mints) {
			if (times.every(time => time <= now - MINT_WINDOW_MS)) this.#mints.delete(userId);
		}
	}
}
