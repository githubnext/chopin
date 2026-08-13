import { describe, expect, it } from "bun:test";

import { Router } from "../http/router";
import { GitHubError } from "../github/client";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerAuthRoutes } from "./routes";

import type { AuthConfig } from "./config";
import type { GitHub, GitHubUser, RepositoryPage } from "../github/client";

function pair(cookie: string): string {
	return cookie.split(";", 1)[0]!;
}

function cookies(response: Response): string[] {
	return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

class FakeGitHub implements GitHub {
	exchanged: { code: string; verifier: string } | undefined;
	denyRepositories = false;

	authorize(input: { state: string; challenge: string }): string {
		let url = new URL("https://github.test/authorize");
		url.searchParams.set("state", input.state);
		url.searchParams.set("challenge", input.challenge);
		return url.href;
	}

	async exchange(input: { code: string; verifier: string }): Promise<string> {
		this.exchanged = input;
		return "gho_route_secret";
	}

	async user(_token: string): Promise<GitHubUser> {
		return { id: "U_octocat", login: "octocat", avatarUrl: "https://avatars.test/octocat" };
	}

	async repositories(_token: string, page: number): Promise<RepositoryPage> {
		if (this.denyRepositories) throw new GitHubError("GitHub API rejected the request", 401);
		return {
			repositories: [{
				id: "R_score",
				owner: "octo-org",
				name: "score",
				fullName: "octo-org/score",
				private: true,
				url: "https://github.test/octo-org/score",
				defaultBranch: "main",
				permissions: { pull: true, push: true, admin: false },
			}],
			nextPage: page + 1,
		};
	}

	async repository(_token: string, owner: string, name: string) {
		return {
			id: "R_score",
			owner,
			name,
			fullName: `${owner}/${name}`,
			private: true,
			url: `https://github.test/${owner}/${name}`,
			defaultBranch: "main",
			permissions: { pull: true, push: true, admin: false },
		};
	}

	async repositoryAccess(token: string, owner: string, name: string) {
		return this.repository(token, owner, name);
	}
}

const CONFIG: AuthConfig = {
	origin: "https://chopin.test",
	clientId: "client-id",
	clientSecret: "client-secret",
	encryptionKey: new Uint8Array(32).fill(6),
};

describe("hosted authentication routes", () => {
	it("signs in, reports the session, lists repositories and logs out", async () => {
		let now = new Date("2026-08-13T12:00:00.000Z");
		let storage = new MemoryStorage();
		let github = new FakeGitHub();
		let router = new Router();
		let revoked: string[] = [];
		registerAuthRoutes(router, {
			config: CONFIG,
			storage,
			github,
			clock: () => now,
			onSessionRevoked: async id => {
				revoked.push(id);
			},
		});

		let start = await router.handle(new Request("https://chopin.test/auth/github"));
		expect(start!.status).toBe(302);
		let authorization = new URL(start!.headers.get("location")!);
		let state = authorization.searchParams.get("state")!;
		expect(state).toHaveLength(43);
		expect(authorization.searchParams.get("challenge")).toHaveLength(43);
		let stateCookie = pair(cookies(start!)[0]!);

		let callback = await router.handle(
			new Request(
				`https://chopin.test/auth/github/callback?code=oauth-code&state=${state}`,
				{ headers: { cookie: stateCookie } },
			),
		);
		expect(callback!.status).toBe(303);
		expect(callback!.headers.get("location")).toBe("/");
		expect(github.exchanged?.code).toBe("oauth-code");
		expect(github.exchanged?.verifier).toHaveLength(43);
		let callbackCookies = cookies(callback!);
		expect(callbackCookies.some(value => value.startsWith("__Host-chopin_oauth_state="))).toBe(
			true,
		);
		let sessionSetCookie = callbackCookies.find(value =>
			value.startsWith("__Host-chopin_session=")
		)!;
		let sessionCookie = pair(sessionSetCookie);

		let session = await router.handle(
			new Request("https://chopin.test/api/session", {
				headers: { cookie: sessionCookie },
			}),
		);
		expect(await session!.json()).toEqual({
			agent: true,
			user: { id: "U_octocat", login: "octocat", avatarUrl: "https://avatars.test/octocat" },
			expiresAt: "2026-09-12T12:00:00.000Z",
		});

		let repositories = await router.handle(
			new Request("https://chopin.test/api/repositories?page=3", {
				headers: { cookie: sessionCookie },
			}),
		);
		expect(repositories!.status).toBe(200);
		expect((await repositories!.json()).nextPage).toBe(4);

		let sessionId = sessionCookie.slice(sessionCookie.indexOf("=") + 1).split(".")[0]!;
		let stored = await storage.sessions.get(sessionId, now);
		expect(Buffer.from(stored!.oauthToken).toString("utf8")).not.toContain("gho_route_secret");

		let refused = await router.handle(
			new Request("https://chopin.test/auth/logout", {
				method: "POST",
				headers: { cookie: sessionCookie, origin: "https://evil.test" },
			}),
		);
		expect(refused!.status).toBe(403);
		let logout = await router.handle(
			new Request("https://chopin.test/auth/logout", {
				method: "POST",
				headers: { cookie: sessionCookie, origin: "https://chopin.test" },
			}),
		);
		expect(logout!.status).toBe(204);
		expect(revoked).toEqual([sessionId]);
		expect(cookies(logout!)[0]).toContain("Max-Age=0");
		let gone = await router.handle(
			new Request("https://chopin.test/api/session", {
				headers: { cookie: sessionCookie },
			}),
		);
		expect(await gone!.json()).toEqual({ user: null, agent: true });
	});

	it("rejects missing or mismatched OAuth state", async () => {
		let router = new Router();
		registerAuthRoutes(router, {
			config: CONFIG,
			storage: new MemoryStorage(),
			github: new FakeGitHub(),
		});

		let missing = await router.handle(
			new Request(
				"https://chopin.test/auth/github/callback?code=code&state=wrong",
			),
		);
		expect(missing!.status).toBe(400);
		expect(await missing!.json()).toEqual({ error: "OAuth state is missing or invalid" });
		expect(cookies(missing!)[0]).toContain("Max-Age=0");
	});

	it("revokes the local session when GitHub rejects its token", async () => {
		let now = new Date("2026-08-13T12:00:00.000Z");
		let storage = new MemoryStorage();
		let github = new FakeGitHub();
		let router = new Router();
		registerAuthRoutes(router, { config: CONFIG, storage, github, clock: () => now });
		let start = await router.handle(new Request("https://chopin.test/auth/github"));
		let authorization = new URL(start!.headers.get("location")!);
		let stateCookie = pair(cookies(start!)[0]!);
		let callback = await router.handle(
			new Request(
				`https://chopin.test/auth/github/callback?code=code&state=${
					authorization.searchParams.get("state")
				}`,
				{ headers: { cookie: stateCookie } },
			),
		);
		let sessionCookie = pair(
			cookies(callback!).find(value => value.startsWith("__Host-chopin_session="))!,
		);
		let sessionId = sessionCookie.slice(sessionCookie.indexOf("=") + 1).split(".")[0]!;

		github.denyRepositories = true;
		let denied = await router.handle(
			new Request("https://chopin.test/api/repositories", {
				headers: { cookie: sessionCookie },
			}),
		);
		expect(denied!.status).toBe(401);
		expect(cookies(denied!)[0]).toContain("Max-Age=0");
		expect(await storage.sessions.get(sessionId, now)).toBeUndefined();
	});
});
