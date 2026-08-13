import { GitHubClient, GitHubError } from "../github/client";
import { StorageError } from "../storage/errors";
import { OAuthAttempts, Sessions } from "./session";

import type { AuthConfig } from "./config";
import type { GitHub } from "../github/client";
import type { Router } from "../http/router";
import type { StorageAdapter } from "../storage/port";

type Clock = () => Date;

type Dependencies = {
	config: AuthConfig;
	storage: StorageAdapter;
	github?: GitHub;
	clock?: Clock;
	agent?: boolean;
	onSessionRevoked?: (sessionId: string) => Promise<void>;
};

export type HostedAuth = {
	config: AuthConfig;
	storage: StorageAdapter;
	github: GitHub;
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

/** Register the GitHub OAuth and authenticated session surface. */
export function registerAuthRoutes(
	router: Router,
	dependencies: Dependencies,
): HostedAuth {
	let clock = dependencies.clock ?? (() => new Date());
	let config = dependencies.config;
	let storage = dependencies.storage;
	let github = dependencies.github ?? new GitHubClient();
	let secure = new URL(config.origin).protocol === "https:";
	let sessions = new Sessions(storage, config.encryptionKey, secure, clock);
	let attempts = new OAuthAttempts(config.encryptionKey, secure, clock);
	let redirectUri = `${config.origin}/auth/github/callback`;
	let context: HostedAuth = { config, storage, github, sessions, clock };

	router.on("GET", "/auth/github", async () => {
		let issued = await attempts.issue();
		let location = github.authorize({
			clientId: config.clientId,
			redirectUri,
			state: issued.state,
			challenge: issued.challenge,
		});
		return redirected(location, 302, [issued.cookie]);
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
			let token = await github.exchange({
				clientId: config.clientId,
				clientSecret: config.clientSecret,
				redirectUri,
				code,
				verifier: stored.verifier,
			});
			let profile = await github.user(token);
			let now = clock();
			await storage.users.put({ ...profile, now });
			let session = await sessions.issue(profile.id, token);
			return redirected("/", 303, [clear, session.cookie]);
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

	router.on("GET", "/api/repositories", async (request, url) => {
		try {
			let requestedPage = page(url);
			if (!requestedPage) {
				return json({ error: "page must be an integer between 1 and 10000" }, 400);
			}
			let authenticated = await sessions.authenticate(request);
			if (!authenticated) return json({ error: "authentication required" }, 401);
			try {
				return json(await github.repositories(authenticated.oauthToken, requestedPage));
			} catch (err) {
				if (err instanceof GitHubError && err.status === 401) {
					let revoked = await sessions.revoke(request);
					if (revoked) await dependencies.onSessionRevoked?.(revoked);
					return json({ error: "GitHub authorization expired" }, 401, sessions.clearCookie());
				}
				throw err;
			}
		} catch (err) {
			return failure(err);
		}
	});

	router.on("POST", "/auth/logout", async request => {
		if (request.headers.get("origin") !== config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let revoked = await sessions.revoke(request);
			if (revoked) await dependencies.onSessionRevoked?.(revoked);
			return empty(204, sessions.clearCookie());
		} catch (err) {
			return failure(err);
		}
	});
	return context;
}
