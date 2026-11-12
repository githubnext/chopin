/**
 * The GitHub App acting as itself: it signs a short JWT with its private key, finds its
 * installation on a repository, and mints installation tokens limited to that one repository and
 * the permissions asked for. Those tokens push and open pull requests as the App's bot.
 */

import { sign } from "node:crypto";

import { GitHubError } from "./client";

import type { AppCredentials } from "../auth/config";

/** GitHub's permission names and levels, as its installation endpoints use them. */
export type AppPermissions = Record<string, "read" | "write">;

export type AppInstallation = {
	id: string;
	suspended: boolean;
	permissions: Record<string, string>;
};

export type InstallationToken = {
	token: string;
	/** Milliseconds since the epoch. */
	expiresAt: number;
	permissions: Record<string, string>;
};

/** A GitHub account as `GET /users/{login}` describes it. */
export type GitHubAccount = { login: string; id: number; nodeId: string; name?: string };

export interface GitHubApp {
	/** The App's installation that covers `owner/name`, or none. */
	installation(owner: string, name: string): Promise<AppInstallation | undefined>;
	/** A token of `installation` for the one repository `name` with exactly `permissions`. */
	token(
		installation: string,
		name: string,
		permissions: AppPermissions,
	): Promise<InstallationToken>;
	/** Gives an installation token back before it expires. */
	revoke(token: string): Promise<void>;
	/** A GitHub account by login, read with `token`; none when there is no such account. */
	account(token: string, login: string): Promise<GitHubAccount | undefined>;
	/** Whether `login` may push to `owner/name` (write, maintain or admin), read with `token`. */
	canPush(token: string, owner: string, name: string, login: string): Promise<boolean>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 15_000;
/** GitHub accepts an App JWT for at most ten minutes; this one is made for nine and reused for eight. */
const JWT_LIFETIME_S = 9 * 60;
const JWT_REUSE_MS = 8 * 60_000;

function base64url(value: string | Uint8Array) {
	return Buffer.from(value).toString("base64url");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function levels(value: unknown): Record<string, string> {
	let result: Record<string, string> = {};
	for (let [name, level] of Object.entries(record(value) ?? {})) {
		if (typeof level === "string") result[name] = level;
	}
	return result;
}

export class GitHubAppClient implements GitHubApp {
	readonly #credentials: AppCredentials;
	readonly #fetch: Fetch;
	readonly #api: string;
	readonly #clock: () => number;
	#jwt: { value: string; until: number } | undefined;

	constructor(
		credentials: AppCredentials,
		options: { fetch?: Fetch; api?: string; clock?: () => number } = {},
	) {
		this.#credentials = credentials;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#api = options.api ?? "https://api.github.com";
		this.#clock = options.clock ?? Date.now;
	}

	/** The App's JWT (RS256), issued a minute early so a slightly fast GitHub clock accepts it. */
	jwt(): string {
		let now = this.#clock();
		if (this.#jwt && this.#jwt.until > now) return this.#jwt.value;
		let seconds = Math.floor(now / 1000);
		let header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
		let payload = base64url(
			JSON.stringify({
				iat: seconds - 60,
				exp: seconds + JWT_LIFETIME_S,
				iss: this.#credentials.id,
			}),
		);
		let signature = sign(
			"RSA-SHA256",
			Buffer.from(`${header}.${payload}`),
			this.#credentials.privateKey,
		);
		let value = `${header}.${payload}.${base64url(signature)}`;
		this.#jwt = { value, until: now + JWT_REUSE_MS };
		return value;
	}

	async installation(owner: string, name: string): Promise<AppInstallation | undefined> {
		let response = await this.#request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
			this.jwt(),
			{ missing: true },
		);
		if (!response) return undefined;
		let item = record(await response.json().catch(() => undefined));
		if (!item || !Number.isSafeInteger(item.id) || (item.id as number) <= 0) {
			throw new GitHubError("GitHub returned an invalid installation");
		}
		return {
			id: String(item.id),
			suspended: item.suspended_at !== null && item.suspended_at !== undefined,
			permissions: levels(item.permissions),
		};
	}

	async token(
		installation: string,
		name: string,
		permissions: AppPermissions,
	): Promise<InstallationToken> {
		let response = await this.#request(
			`/app/installations/${encodeURIComponent(installation)}/access_tokens`,
			this.jwt(),
			{ body: { repositories: [name], permissions } },
		);
		let item = record(await response!.json().catch(() => undefined));
		let expiresAt = typeof item?.expires_at === "string" ? Date.parse(item.expires_at) : NaN;
		if (!item || typeof item.token !== "string" || !item.token || Number.isNaN(expiresAt)) {
			throw new GitHubError("GitHub returned an invalid installation token");
		}
		return { token: item.token, expiresAt, permissions: levels(item.permissions) };
	}

	async revoke(token: string): Promise<void> {
		await this.#request("/installation/token", token, { method: "DELETE", missing: true });
	}

	async account(token: string, login: string): Promise<GitHubAccount | undefined> {
		let response = await this.#request(`/users/${encodeURIComponent(login)}`, token, {
			missing: true,
		});
		if (!response) return undefined;
		let item = record(await response.json().catch(() => undefined));
		if (
			!item || typeof item.login !== "string" || !Number.isSafeInteger(item.id)
			|| typeof item.node_id !== "string"
		) throw new GitHubError("GitHub returned an invalid user");
		return {
			login: item.login,
			id: item.id as number,
			nodeId: item.node_id,
			...(typeof item.name === "string" && item.name.trim() ? { name: item.name.trim() } : {}),
		};
	}

	async canPush(token: string, owner: string, name: string, login: string): Promise<boolean> {
		let response = await this.#request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators/${
				encodeURIComponent(login)
			}/permission`,
			token,
			{ missing: true },
		);
		if (!response) return false;
		let item = record(await response.json().catch(() => undefined));
		let permissions = record(record(item?.user)?.permissions);
		if (permissions) return permissions.push === true || permissions.admin === true;
		return item?.permission === "admin" || item?.permission === "write";
	}

	/** A GitHub API call; with `missing`, a 404 is no answer rather than an error. */
	async #request(
		path: string,
		bearer: string,
		options: { body?: unknown; method?: string; missing?: boolean } = {},
	): Promise<Response | undefined> {
		let response: Response;
		try {
			response = await this.#fetch(new URL(path, this.#api), {
				method: options.method ?? (options.body === undefined ? "GET" : "POST"),
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${bearer}`,
					"user-agent": "chopin",
					"x-github-api-version": "2022-11-28",
					...(options.body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
				redirect: "error",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new GitHubError("GitHub API is unavailable");
		}
		if (options.missing && response.status === 404) return undefined;
		if (!response.ok) {
			let status = [401, 403, 404, 422].includes(response.status) ? response.status : 502;
			throw new GitHubError("GitHub API rejected the request", status);
		}
		return response;
	}
}
