import { GitHubClient, GitHubError } from "../github/client";
import { StorageError } from "../storage/errors";
import { Admission, AdmissionDenied } from "./admission";
import { OAuthAttempts, Sessions } from "./session";

import type { AuthConfig } from "./config";
import type { GitHub, GitHubConditional } from "../github/client";
import type { Router } from "../http/router";
import type { StorageAdapter } from "../storage/port";

type Clock = () => Date;

const RETURN_PATH_MAX_LENGTH = 2_048;
const RESERVED_RETURN_PATHS = ["/api", "/auth", "/ws", "/mcp"];

type Dependencies = {
	config: AuthConfig;
	storage: StorageAdapter;
	github?: GitHub;
	clock?: Clock;
	agent?: boolean;
	onSessionRevoked?: (sessionId: string) => Promise<void>;
	onCredentialsWillRotate?: (sessionId: string, revision: number) => Promise<void>;
};

export type HostedAuth = {
	config: AuthConfig;
	storage: StorageAdapter;
	github: GitHub;
	admission: Admission;
	sessions: Sessions;
	clock: Clock;
};

function headers(): Headers {
	return new Headers({
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	});
}

function json(value: unknown, status = 200, cookie?: string): Response {
	let responseHeaders = headers();
	if (cookie) responseHeaders.append("set-cookie", cookie);
	return Response.json(value, { status, headers: responseHeaders });
}

function empty(status: number, cookie?: string): Response {
	let responseHeaders = headers();
	responseHeaders.delete("content-type");
	if (cookie) responseHeaders.append("set-cookie", cookie);
	return new Response(null, { status, headers: responseHeaders });
}

function conditional<T extends object>(value: GitHubConditional<T>): Response {
	let responseHeaders = headers();
	if (value.etag) responseHeaders.set("etag", value.etag);
	if ("notModified" in value) {
		responseHeaders.delete("content-type");
		return new Response(null, { status: 304, headers: responseHeaders });
	}
	let { etag: _etag, ...body } = value;
	return Response.json(body, { headers: responseHeaders });
}

function redirected(location: string, status: 302 | 303, cookies: string[]): Response {
	let responseHeaders = new Headers({
		"cache-control": "no-store",
		location,
		"referrer-policy": "no-referrer",
	});
	for (let cookie of cookies) responseHeaders.append("set-cookie", cookie);
	return new Response(null, { status, headers: responseHeaders });
}

function failure(err: unknown): Response {
	if (err instanceof AdmissionDenied) {
		return json({ error: err.message }, 403);
	}
	if (err instanceof GitHubError) {
		return json({ error: err.message }, err.status);
	}
	if (err instanceof StorageError) {
		return json(
			{
				error: err.failure === "unavailable" ? "storage is unavailable" : "session storage failed",
			},
			err.failure === "unavailable" ? 503 : 500,
		);
	}
	return json({ error: "request failed" }, 500);
}

function page(url: URL): number | undefined {
	let values = url.searchParams.getAll("page");
	if (values.length === 0) return 1;
	if (values.length !== 1 || !/^\d+$/.test(values[0]!)) return undefined;
	let parsed = Number(values[0]);
	return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : undefined;
}

function parameter(url: URL, name: string): string | undefined {
	let values = url.searchParams.getAll(name);
	return values.length === 1 && values[0] ? values[0] : undefined;
}

function returnPath(url: URL, origin: string): string {
	let values = url.searchParams.getAll("return_to");
	if (values.length !== 1) return "/";
	let value = values[0]!;
	if (
		!value
		|| value.length > RETURN_PATH_MAX_LENGTH
		|| !value.startsWith("/")
		|| value.startsWith("//")
		|| value.includes("\\")
	) return "/";
	let hasControl = [...value].some(character => {
		let code = character.charCodeAt(0);
		return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
	});
	if (hasControl) return "/";

	let target: URL;
	try {
		target = new URL(value, origin);
	} catch {
		return "/";
	}
	if (target.origin !== origin || target.pathname.startsWith("//")) return "/";
	if (
		RESERVED_RETURN_PATHS.some(path =>
			target.pathname === path || target.pathname.startsWith(`${path}/`)
		)
	) return "/";
	let canonical = target.pathname + target.search + target.hash;
	return canonical.length <= RETURN_PATH_MAX_LENGTH ? canonical : "/";
}

/** Register the GitHub OAuth and authenticated session surface. */
export function registerAuthRoutes(
	router: Router,
	dependencies: Dependencies,
): HostedAuth {
	let clock = dependencies.clock ?? (() => new Date());
	let config = dependencies.config;
	let storage = dependencies.storage;
	let github = dependencies.github ?? new GitHubClient();
	let admission = new Admission(config, github, () => clock().getTime());
	let secure = new URL(config.origin).protocol === "https:";
	let sessions = new Sessions(storage, secure, clock, {
		refresh: refreshToken =>
			github.refresh({
				clientId: config.clientId,
				clientSecret: config.clientSecret,
				refreshToken,
			}),
		beforeRefresh: dependencies.onCredentialsWillRotate,
		onRevoked: dependencies.onSessionRevoked,
		authorize: admission.restricted
			? (user, token) => admission.allowed(token, user.id)
			: undefined,
		invalidate: token => admission.invalidate(token),
	});
	let attempts = new OAuthAttempts(config.encryptionKey, secure, clock);
	let redirectUri = `${config.origin}/auth/github/callback`;
	let context: HostedAuth = { config, storage, github, admission, sessions, clock };

	router.on("GET", "/auth/github", async (_request, url) => {
		let issued = await attempts.issue(returnPath(url, config.origin));
		let location = github.authorize({
			clientId: config.clientId,
			redirectUri,
			state: issued.state,
			challenge: issued.challenge,
		});
		return redirected(location, 302, [issued.cookie]);
	});

	router.on("GET", "/auth/github/install", () =>
		redirected(
			`https://github.com/apps/${encodeURIComponent(config.appSlug)}/installations/new`,
			302,
			[],
		));

	// GitHub's installation_id query parameter is intentionally ignored. API access is
	// always re-established from the signed-in user's token.
	router.on("GET", "/auth/github/setup", async request => {
		let authenticated = await sessions.authenticate(request).catch(() => undefined);
		if (authenticated) admission.invalidate(authenticated.access.token);
		return redirected("/?repository_access=changed", 303, []);
	});

	router.on("GET", "/auth/github/callback", async (request, url) => {
		let clear = attempts.clearCookie();
		try {
			if (url.searchParams.has("error")) {
				return json({ error: "GitHub authorization was denied" }, 400, clear);
			}
			let code = parameter(url, "code");
			let state = parameter(url, "state");
			let stored = await attempts.read(request);
			if (!code || !state || !stored || stored.state !== state) {
				return json({ error: "OAuth state is missing or invalid" }, 400, clear);
			}
			let grant = await github.exchange({
				clientId: config.clientId,
				clientSecret: config.clientSecret,
				redirectUri,
				code,
				verifier: stored.verifier,
			});
			let profile = await admission.user(grant.accessToken);
			let now = clock();
			await storage.users.put({ ...profile, now });
			let session = await sessions.issue(profile.id, grant);
			return redirected(stored.returnPath ?? "/", 303, [clear, session.cookie]);
		} catch (err) {
			let response = failure(err);
			response.headers.append("set-cookie", clear);
			return response;
		}
	});

	router.on("GET", "/api/session", async request => {
		try {
			let authenticated = await sessions.authenticate(request);
			if (!authenticated) {
				return json({ user: null, agent: dependencies.agent ?? true });
			}
			return json({
				agent: dependencies.agent ?? true,
				installUrl: "/auth/github/install",
				user: {
					id: authenticated.user.id,
					login: authenticated.user.login,
					avatarUrl: authenticated.user.avatarUrl,
				},
				expiresAt: authenticated.session.expiresAt.toISOString(),
			});
		} catch (err) {
			return failure(err);
		}
	});

	router.on("GET", "/api/github/installations", async (request, url) => {
		try {
			let requestedPage = page(url);
			if (!requestedPage) {
				return json({ error: "page must be an integer between 1 and 10000" }, 400);
			}
			let authenticated = await sessions.authenticate(request);
			if (!authenticated) return json({ error: "authentication required" }, 401);
			try {
				let result = await sessions.use(
					authenticated,
					token =>
						github.installations(token, requestedPage, {
							ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
						}),
				);
				return conditional(result.value);
			} catch (err) {
				if (err instanceof GitHubError && err.status === 401) {
					return json({ error: "GitHub authorization expired" }, 401, sessions.clearCookie());
				}
				throw err;
			}
		} catch (err) {
			return failure(err);
		}
	});

	router.on(
		"GET",
		"/api/github/installations/:installationId/repositories",
		async (request, url, params) => {
			try {
				let requestedPage = page(url);
				if (!requestedPage) {
					return json({ error: "page must be an integer between 1 and 10000" }, 400);
				}
				let installationId = params.installationId!;
				if (!/^\d+$/.test(installationId)) {
					return json({ error: "installation not found" }, 404);
				}
				let authenticated = await sessions.authenticate(request);
				if (!authenticated) return json({ error: "authentication required" }, 401);
				try {
					let result = await sessions.use(
						authenticated,
						token =>
							github.installationRepositories(token, installationId, requestedPage, {
								ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
							}),
					);
					return conditional(result.value);
				} catch (err) {
					if (err instanceof GitHubError && err.status === 401) {
						return json(
							{ error: "GitHub authorization expired" },
							401,
							sessions.clearCookie(),
						);
					}
					throw err;
				}
			} catch (err) {
				return failure(err);
			}
		},
	);

	router.on("POST", "/auth/logout", async request => {
		if (request.headers.get("origin") !== config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			await sessions.revoke(request);
			return empty(204, sessions.clearCookie());
		} catch (err) {
			return failure(err);
		}
	});
	return context;
}
