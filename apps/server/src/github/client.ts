export type GitHubUser = {
	id: string;
	login: string;
	avatarUrl: string;
};

export type GitHubOrganizationMembership = {
	state: "active" | "pending";
	role: "admin" | "member" | "billing_manager";
};

export type Repository = {
	id: string;
	owner: string;
	ownerAvatarUrl?: string;
	name: string;
	fullName: string;
	private: boolean;
	url: string;
	defaultBranch: string;
	permissions: {
		pull: boolean;
		push: boolean;
		admin: boolean;
	};
};

export type RepositoryPage = {
	repositories: Repository[];
	nextPage: number | undefined;
};

export type GitHubInstallation = {
	id: string;
	account: {
		login: string;
		avatarUrl: string;
		type: "user" | "organization";
	};
	repositorySelection: "all" | "selected";
	configureUrl: string;
	suspended: boolean;
	permissions: {
		contents: boolean;
		pullRequests: boolean;
		checks: boolean;
		statuses: boolean;
	};
};

export type InstallationPage = {
	installations: GitHubInstallation[];
	nextPage: number | undefined;
};

export type GitHubTokenGrant = {
	accessToken: string;
	accessExpiresIn: number;
	refreshToken: string;
	refreshExpiresIn: number;
};

export interface GitHub {
	authorize(input: {
		clientId: string;
		redirectUri: string;
		state: string;
		challenge: string;
	}): string;
	exchange(input: {
		clientId: string;
		clientSecret: string;
		redirectUri: string;
		code: string;
		verifier: string;
	}): Promise<GitHubTokenGrant>;
	refresh(input: {
		clientId: string;
		clientSecret: string;
		refreshToken: string;
	}): Promise<GitHubTokenGrant>;
	user(token: string): Promise<GitHubUser>;
	organizationMembership(
		token: string,
		organization: string,
	): Promise<GitHubOrganizationMembership | undefined>;
	installations(token: string, page: number): Promise<InstallationPage>;
	installationRepositories(
		token: string,
		installationId: string,
		page: number,
	): Promise<RepositoryPage>;
	/** Resolve the repository role granted directly to a bearer token. */
	repository(token: string, owner: string, name: string): Promise<Repository>;
	/** Resolve the repository role within this GitHub App's active installations. */
	repositoryAccess(token: string, owner: string, name: string): Promise<Repository | undefined>;
	invalidate(token: string): void;
}

export class GitHubError extends Error {
	readonly status: number;

	constructor(message: string, status = 502) {
		super(message);
		this.name = "GitHubError";
		this.status = status;
	}
}

export class GitHubTokenError extends GitHubError {
	readonly terminal: boolean;

	constructor(message: string, status = 502, terminal = false) {
		super(message, status);
		this.name = "GitHubTokenError";
		this.terminal = terminal;
	}
}

type Endpoints = {
	authorize: string;
	token: string;
	api: string;
};

type Options = {
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	endpoints?: Partial<Endpoints>;
	clock?: () => number;
};

type CachedAccess = {
	expiresAt: number;
	installations: Promise<GitHubInstallation[]>;
	repositories: Map<string, RepositoryListing>;
};

type RepositoryListing = {
	complete: boolean;
	index: Map<string, Repository>;
	loading?: Promise<void>;
	nextPage: number;
	visited: Set<number>;
};

const DEFAULTS: Endpoints = {
	authorize: "https://github.com/login/oauth/authorize",
	token: "https://github.com/login/oauth/access_token",
	api: "https://api.github.com",
};

const REQUEST_TIMEOUT_MS = 15_000;
const ACCESS_CACHE_MS = 30_000;
const MAX_LIST_PAGES = 100;

function tokenKey(token: string): string {
	return createHash("sha256").update(token).digest("base64url");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function user(value: unknown): GitHubUser {
	let item = record(value);
	if (
		!item
		|| typeof item.node_id !== "string"
		|| typeof item.login !== "string"
		|| typeof item.avatar_url !== "string"
	) throw new GitHubError("GitHub returned an invalid user");
	return { id: item.node_id, login: item.login, avatarUrl: item.avatar_url };
}

function organizationMembership(value: unknown): GitHubOrganizationMembership {
	let item = record(value);
	if (
		!item
		|| (item.state !== "active" && item.state !== "pending")
		|| (item.role !== "admin" && item.role !== "member" && item.role !== "billing_manager")
	) throw new GitHubError("GitHub returned an invalid organization membership");
	return { state: item.state, role: item.role };
}

function repository(value: unknown): Repository {
	let item = record(value);
	let owner = record(item?.owner);
	let permissions = record(item?.permissions);
	if (
		!item
		|| !owner
		|| !permissions
		|| typeof item.node_id !== "string"
		|| typeof owner.login !== "string"
		|| typeof item.name !== "string"
		|| typeof item.full_name !== "string"
		|| typeof item.private !== "boolean"
		|| typeof item.html_url !== "string"
		|| typeof item.default_branch !== "string"
		|| typeof permissions.pull !== "boolean"
		|| typeof permissions.push !== "boolean"
		|| typeof permissions.admin !== "boolean"
	) throw new GitHubError("GitHub returned an invalid repository");
	return {
		id: item.node_id,
		owner: owner.login,
		...(typeof owner.avatar_url === "string" ? { ownerAvatarUrl: owner.avatar_url } : {}),
		name: item.name,
		fullName: item.full_name,
		private: item.private,
		url: item.html_url,
		defaultBranch: item.default_branch,
		permissions: {
			pull: permissions.pull,
			push: permissions.push,
			admin: permissions.admin,
		},
	};
}

function installation(value: unknown): GitHubInstallation {
	let item = record(value);
	let account = record(item?.account);
	let permissions = record(item?.permissions);
	let type: "user" | "organization" | undefined = account?.type === "User"
		? "user"
		: account?.type === "Organization"
		? "organization"
		: undefined;
	if (
		!item
		|| !account
		|| !permissions
		|| !Number.isSafeInteger(item.id)
		|| (item.id as number) <= 0
		|| typeof account.login !== "string"
		|| typeof account.avatar_url !== "string"
		|| !type
		|| (item.repository_selection !== "all" && item.repository_selection !== "selected")
		|| typeof item.html_url !== "string"
		|| !(item.suspended_at === null || typeof item.suspended_at === "string")
	) throw new GitHubError("GitHub returned an invalid installation");
	let allowed = (name: string) => permissions[name] === "read" || permissions[name] === "write";
	return {
		id: String(item.id),
		account: { login: account.login, avatarUrl: account.avatar_url, type },
		repositorySelection: item.repository_selection,
		configureUrl: item.html_url,
		suspended: item.suspended_at !== null,
		permissions: {
			contents: allowed("contents"),
			pullRequests: allowed("pull_requests"),
			checks: allowed("checks"),
			statuses: allowed("statuses"),
		},
	};
}

async function body(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new GitHubError("GitHub returned an unreadable response");
	}
}

async function isRateLimited(response: Response): Promise<boolean> {
	if (response.status === 429) return true;
	if (response.status !== 403) return false;
	if (
		response.headers.get("x-ratelimit-remaining") === "0"
		|| response.headers.has("retry-after")
	) return true;
	try {
		let value = record(await response.clone().json());
		return (typeof value?.message === "string"
			&& /(rate limit|abuse detection)/i.test(value.message))
			|| (typeof value?.documentation_url === "string"
				&& /(rate-limits|rate_limit)/i.test(value.documentation_url));
	} catch {
		return false;
	}
}

function nextPage(link: string | null, api: string, path: string): number | undefined {
	if (!link) return undefined;
	let next = link.split(",").map(part => part.trim()).find(part => /;\s*rel="next"$/.test(part));
	let match = next?.match(/^<([^>]+)>/);
	if (!match) return undefined;
	try {
		let url = new URL(match[1]!);
		let expected = new URL(api);
		if (url.origin !== expected.origin || url.pathname !== path) return undefined;
		let page = Number(url.searchParams.get("page"));
		return Number.isSafeInteger(page) && page > 0 ? page : undefined;
	} catch {
		return undefined;
	}
}

/** Narrow GitHub OAuth and repository API client with validated responses. */
export class GitHubClient implements GitHub {
	readonly #fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	readonly #endpoints: Endpoints;
	readonly #clock: () => number;
	readonly #access = new Map<string, CachedAccess>();

	constructor(options: Options = {}) {
		this.#fetch = options.fetch ?? fetch;
		this.#endpoints = { ...DEFAULTS, ...options.endpoints };
		this.#clock = options.clock ?? Date.now;
	}

	authorize(input: {
		clientId: string;
		redirectUri: string;
		state: string;
		challenge: string;
	}): string {
		let url = new URL(this.#endpoints.authorize);
		url.searchParams.set("client_id", input.clientId);
		url.searchParams.set("redirect_uri", input.redirectUri);
		url.searchParams.set("state", input.state);
		url.searchParams.set("code_challenge", input.challenge);
		url.searchParams.set("code_challenge_method", "S256");
		return url.href;
	}

	async exchange(input: {
		clientId: string;
		clientSecret: string;
		redirectUri: string;
		code: string;
		verifier: string;
	}): Promise<GitHubTokenGrant> {
		return this.#token({
			client_id: input.clientId,
			client_secret: input.clientSecret,
			code: input.code,
			redirect_uri: input.redirectUri,
			code_verifier: input.verifier,
		}, false);
	}

	async refresh(input: {
		clientId: string;
		clientSecret: string;
		refreshToken: string;
	}): Promise<GitHubTokenGrant> {
		return this.#token({
			client_id: input.clientId,
			client_secret: input.clientSecret,
			grant_type: "refresh_token",
			refresh_token: input.refreshToken,
		}, true);
	}

	async #token(parameters: Record<string, string>, refreshing: boolean): Promise<GitHubTokenGrant> {
		let response: Response;
		try {
			response = await this.#fetch(this.#endpoints.token, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams(parameters),
				redirect: "error",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new GitHubError("GitHub OAuth is unavailable");
		}
		let value = record(await body(response));
		let terminal = refreshing && value?.error === "bad_refresh_token";
		if (!response.ok || value?.error) {
			throw new GitHubTokenError(
				refreshing ? "GitHub rejected the token refresh" : "GitHub rejected the OAuth exchange",
				terminal ? 401 : response.status === 429 ? 429 : 502,
				terminal,
			);
		}
		if (
			typeof value?.access_token !== "string"
			|| !value.access_token
			|| typeof value.refresh_token !== "string"
			|| !value.refresh_token
			|| !Number.isSafeInteger(value.expires_in)
			|| (value.expires_in as number) <= 0
			|| !Number.isSafeInteger(value.refresh_token_expires_in)
			|| (value.refresh_token_expires_in as number) <= 0
			|| value.token_type !== "bearer"
		) {
			throw new GitHubTokenError("GitHub returned an invalid expiring user token");
		}
		return {
			accessToken: value.access_token,
			accessExpiresIn: value.expires_in as number,
			refreshToken: value.refresh_token,
			refreshExpiresIn: value.refresh_token_expires_in as number,
		};
	}

	async user(token: string): Promise<GitHubUser> {
		return user(await this.#api("/user", token));
	}

	async organizationMembership(
		token: string,
		organization: string,
	): Promise<GitHubOrganizationMembership | undefined> {
		try {
			return organizationMembership(
				await this.#api(`/user/memberships/orgs/${encodeURIComponent(organization)}`, token),
			);
		} catch (err) {
			if (err instanceof GitHubError && err.status === 404) return undefined;
			throw err;
		}
	}

	async installations(token: string, page: number): Promise<InstallationPage> {
		let path = "/user/installations";
		let url = new URL(path, this.#endpoints.api);
		url.searchParams.set("per_page", "100");
		url.searchParams.set("page", String(page));
		let response = await this.#request(url, token);
		let value = record(await body(response));
		if (!Array.isArray(value?.installations)) {
			throw new GitHubError("GitHub returned an invalid installation list");
		}
		return {
			installations: value.installations.map(installation),
			nextPage: nextPage(response.headers.get("link"), this.#endpoints.api, path),
		};
	}

	async installationRepositories(
		token: string,
		installationId: string,
		page: number,
	): Promise<RepositoryPage> {
		if (!/^\d+$/.test(installationId)) throw new GitHubError("installation not found", 404);
		let path = `/user/installations/${installationId}/repositories`;
		let url = new URL(path, this.#endpoints.api);
		url.searchParams.set("per_page", "100");
		url.searchParams.set("page", String(page));
		let response = await this.#request(url, token);
		let value = record(await body(response));
		if (!Array.isArray(value?.repositories)) {
			throw new GitHubError("GitHub returned an invalid repository list");
		}
		return {
			repositories: value.repositories.map(repository),
			nextPage: nextPage(response.headers.get("link"), this.#endpoints.api, path),
		};
	}

	async repository(token: string, owner: string, name: string): Promise<Repository> {
		let path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
		return repository(await this.#api(path, token));
	}

	async repositoryAccess(
		token: string,
		owner: string,
		name: string,
	): Promise<Repository | undefined> {
		let fullName = `${owner}/${name}`.toLowerCase();
		let now = this.#clock();
		for (let [key, entry] of this.#access) {
			if (entry.expiresAt <= now) this.#access.delete(key);
		}
		let key = tokenKey(token);
		let cached = this.#access.get(key);
		if (!cached || cached.expiresAt <= now) {
			cached = {
				expiresAt: now + ACCESS_CACHE_MS,
				installations: this.#installationIndex(token),
				repositories: new Map(),
			};
			this.#access.set(key, cached);
		}
		try {
			let installations = await cached.installations;
			for (let installed of installations) {
				if (
					installed.suspended
					|| !installed.permissions.contents
					|| installed.account.login.toLowerCase() !== owner.toLowerCase()
				) continue;
				let listing = cached.repositories.get(installed.id);
				if (!listing) {
					listing = {
						complete: false,
						index: new Map(),
						nextPage: 1,
						visited: new Set(),
					};
					cached.repositories.set(installed.id, listing);
				}
				let found = await this.#findRepository(token, installed.id, fullName, listing);
				if (found) return found;
			}
			return undefined;
		} catch (err) {
			if (this.#access.get(key) === cached) this.#access.delete(key);
			throw err;
		}
	}

	invalidate(token: string): void {
		this.#access.delete(tokenKey(token));
	}

	async #installationIndex(token: string): Promise<GitHubInstallation[]> {
		let index: GitHubInstallation[] = [];
		let installationPage = 1;
		let installationPages = new Set<number>();
		while (!installationPages.has(installationPage)) {
			if (installationPages.size >= MAX_LIST_PAGES) {
				throw new GitHubError("GitHub installation listing exceeded its safety limit");
			}
			installationPages.add(installationPage);
			let result = await this.installations(token, installationPage);
			index.push(...result.installations);
			if (!result.nextPage) return index;
			installationPage = result.nextPage;
		}
		return index;
	}

	async #findRepository(
		token: string,
		installationId: string,
		fullName: string,
		listing: RepositoryListing,
	): Promise<Repository | undefined> {
		while (true) {
			let found = listing.index.get(fullName);
			if (found || listing.complete) return found;
			if (listing.loading) {
				await listing.loading;
				continue;
			}
			if (listing.visited.size >= MAX_LIST_PAGES || listing.visited.has(listing.nextPage)) {
				throw new GitHubError("GitHub repository listing exceeded its safety limit");
			}
			let page = listing.nextPage;
			listing.visited.add(page);
			let loading = this.installationRepositories(token, installationId, page).then(result => {
				for (let item of result.repositories) {
					listing.index.set(item.fullName.toLowerCase(), item);
				}
				if (result.nextPage) listing.nextPage = result.nextPage;
				else listing.complete = true;
			});
			listing.loading = loading;
			try {
				await loading;
			} finally {
				if (listing.loading === loading) listing.loading = undefined;
			}
		}
	}

	async #api(path: string, token: string): Promise<unknown> {
		return body(await this.#request(new URL(path, this.#endpoints.api), token));
	}

	async #request(url: URL, token: string): Promise<Response> {
		let response: Response;
		try {
			response = await this.#fetch(url, {
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${token}`,
					"user-agent": "chopin",
					"x-github-api-version": "2022-11-28",
				},
				redirect: "error",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new GitHubError("GitHub API is unavailable");
		}
		if (!response.ok) {
			let rateLimited = await isRateLimited(response);
			let status = rateLimited
				? 429
				: response.status === 401
						|| response.status === 403
						|| response.status === 404
				? response.status
				: 502;
			throw new GitHubError("GitHub API rejected the request", status);
		}
		return response;
	}
}
import { createHash } from "node:crypto";
