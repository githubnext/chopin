export type GitHubUser = {
	id: string;
	login: string;
	avatarUrl: string;
};

export type Repository = {
	id: string;
	owner: string;
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
	}): Promise<string>;
	user(token: string): Promise<GitHubUser>;
	repositories(token: string, page: number): Promise<RepositoryPage>;
	repository(token: string, owner: string, name: string): Promise<Repository>;
	repositoryAccess(token: string, owner: string, name: string): Promise<Repository | undefined>;
}

export class GitHubError extends Error {
	readonly status: number;

	constructor(message: string, status = 502) {
		super(message);
		this.name = "GitHubError";
		this.status = status;
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
};

const DEFAULTS: Endpoints = {
	authorize: "https://github.com/login/oauth/authorize",
	token: "https://github.com/login/oauth/access_token",
	api: "https://api.github.com",
};

const REQUEST_TIMEOUT_MS = 15_000;

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

async function body(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new GitHubError("GitHub returned an unreadable response");
	}
}

function nextPage(link: string | null, api: string): number | undefined {
	if (!link) return undefined;
	let next = link.split(",").map(part => part.trim()).find(part => /;\s*rel="next"$/.test(part));
	let match = next?.match(/^<([^>]+)>/);
	if (!match) return undefined;
	try {
		let url = new URL(match[1]!);
		let expected = new URL(api);
		if (url.origin !== expected.origin || url.pathname !== "/user/repos") return undefined;
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

	constructor(options: Options = {}) {
		this.#fetch = options.fetch ?? fetch;
		this.#endpoints = { ...DEFAULTS, ...options.endpoints };
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
		url.searchParams.set("scope", "read:user repo");
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
	}): Promise<string> {
		let response: Response;
		try {
			response = await this.#fetch(this.#endpoints.token, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					client_id: input.clientId,
					client_secret: input.clientSecret,
					code: input.code,
					redirect_uri: input.redirectUri,
					code_verifier: input.verifier,
				}),
				redirect: "error",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new GitHubError("GitHub OAuth is unavailable");
		}
		let value = record(await body(response));
		if (!response.ok || value?.error || typeof value?.access_token !== "string") {
			throw new GitHubError(
				"GitHub rejected the OAuth exchange",
				response.status === 429 ? 429 : 502,
			);
		}
		return value.access_token;
	}

	async user(token: string): Promise<GitHubUser> {
		return user(await this.#api("/user", token));
	}

	async repositories(token: string, page: number): Promise<RepositoryPage> {
		let url = new URL("/user/repos", this.#endpoints.api);
		url.searchParams.set("affiliation", "owner,collaborator,organization_member");
		url.searchParams.set("per_page", "100");
		url.searchParams.set("page", String(page));
		url.searchParams.set("sort", "updated");
		let response = await this.#request(url, token);
		let value = await body(response);
		if (!Array.isArray(value)) throw new GitHubError("GitHub returned an invalid repository list");
		return {
			repositories: value.map(repository),
			nextPage: nextPage(response.headers.get("link"), this.#endpoints.api),
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
		let page = 1;
		for (let request = 0; request < 20; request++) {
			let result = await this.repositories(token, page);
			let found = result.repositories.find(item => item.fullName.toLowerCase() === fullName);
			if (found) return found;
			if (!result.nextPage || result.nextPage === page) return undefined;
			page = result.nextPage;
		}
		throw new GitHubError("GitHub repository listing exceeded its safety limit");
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
			let status = response.status === 401
					|| response.status === 403
					|| response.status === 404
					|| response.status === 429
				? response.status
				: 502;
			throw new GitHubError("GitHub API rejected the request", status);
		}
		return response;
	}
}
