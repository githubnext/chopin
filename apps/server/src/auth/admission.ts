import { createHash } from "node:crypto";

import { GitHubError } from "../github/client";

import type { AuthConfig } from "./config";
import type { GitHub, GitHubUser } from "../github/client";

type Decision = { kind: "allowed"; user: GitHubUser } | { kind: "denied" };

type CachedDecision = {
	expiresAt: number;
	decision: Promise<Decision>;
};

const CACHE_MS = 30_000;

function tokenKey(token: string): string {
	return createHash("sha256").update(token).digest("base64url");
}

/** A verified GitHub identity that is outside this instance's admission policy. */
export class AdmissionDenied extends Error {
	constructor() {
		super("GitHub account is not allowed to use this Chopin instance");
		this.name = "AdmissionDenied";
	}
}

/** Resolve provider identity and the instance-wide user/organization policy. */
export class Admission {
	readonly #config: AuthConfig;
	readonly #github: GitHub;
	readonly #clock: () => number;
	readonly #cache = new Map<string, CachedDecision>();

	constructor(config: AuthConfig, github: GitHub, clock: () => number = Date.now) {
		this.#config = config;
		this.#github = github;
		this.#clock = clock;
	}

	get restricted(): boolean {
		return !!this.#config.allowedUsers?.size || !!this.#config.allowedOrganizations?.size;
	}

	async user(token: string): Promise<GitHubUser> {
		let decision = await this.#decision(token);
		if (decision.kind === "denied") throw new AdmissionDenied();
		return decision.user;
	}

	async allowed(token: string, expectedUserId?: string): Promise<boolean> {
		if (!this.restricted) return true;
		let decision = await this.#decision(token);
		return decision.kind === "allowed"
			&& (!expectedUserId || decision.user.id === expectedUserId);
	}

	invalidate(token: string): void {
		this.#cache.delete(tokenKey(token));
		this.#github.invalidate(token);
	}

	async #decision(token: string): Promise<Decision> {
		let now = this.#clock();
		for (let [key, value] of this.#cache) {
			if (value.expiresAt <= now) this.#cache.delete(key);
		}
		let key = tokenKey(token);
		let cached = this.#cache.get(key);
		if (!cached) {
			cached = { expiresAt: now + CACHE_MS, decision: this.#resolve(token) };
			this.#cache.set(key, cached);
		}
		try {
			return await cached.decision;
		} catch (err) {
			if (this.#cache.get(key) === cached) this.#cache.delete(key);
			throw err;
		}
	}

	async #resolve(token: string): Promise<Decision> {
		let user: GitHubUser;
		try {
			user = await this.#github.user(token);
		} catch (err) {
			if (err instanceof GitHubError) {
				if (err.status === 401) throw err;
				throw new GitHubError("GitHub admission is temporarily unavailable", 503);
			}
			throw err;
		}

		if (!this.restricted) return { kind: "allowed", user };
		if (this.#config.allowedUsers?.has(user.login.toLowerCase())) {
			return { kind: "allowed", user };
		}

		let unavailable = false;
		for (let organization of this.#config.allowedOrganizations ?? []) {
			try {
				let membership = await this.#github.organizationMembership(token, organization);
				if (
					membership?.state === "active"
					&& (membership.role === "admin" || membership.role === "member")
				) return { kind: "allowed", user };
			} catch (err) {
				if (err instanceof GitHubError && err.status === 401) throw err;
				if (err instanceof GitHubError) unavailable = true;
				else throw err;
			}
		}
		if (unavailable) {
			throw new GitHubError("GitHub organization membership is temporarily unavailable", 503);
		}
		return { kind: "denied" };
	}
}
