import { describe, expect, it } from "bun:test";

import { Router } from "../http/router";
import { GitHubError } from "../github/client";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerAuthRoutes } from "./routes";

import type { AuthConfig } from "./config";
import type {
	GitHub,
	GitHubOrganizationMembership,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	RepositoryPage,
} from "../github/client";

function pair(cookie: string): string {
	return cookie.split(";", 1)[0]!;
}

function cookies(response: Response): string[] {
	return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

class FakeGitHub implements GitHub {
	authorized: Parameters<GitHub["authorize"]>[0] | undefined;
	exchanged: Parameters<GitHub["exchange"]>[0] | undefined;
	denyRepositories = false;
	invalidated: string[] = [];
	membership: GitHubOrganizationMembership | undefined;
	membershipFailure: GitHubError | undefined;
	membershipCalls: string[] = [];

	authorize(input: Parameters<GitHub["authorize"]>[0]): string {
		this.authorized = input;
		let url = new URL("https://github.test/authorize");
		url.searchParams.set("state", input.state);
		url.searchParams.set("challenge", input.challenge);
		return url.href;
	}

	async exchange(input: Parameters<GitHub["exchange"]>[0]): Promise<GitHubTokenGrant> {
		this.exchanged = input;
		return this.grant("ghu_route_secret", "ghr_route_secret");
	}

	async refresh(_input: Parameters<GitHub["refresh"]>[0]): Promise<GitHubTokenGrant> {
		return this.grant("ghu_route_refreshed", "ghr_route_refreshed");
	}

	async user(_token: string): Promise<GitHubUser> {
		return { id: "U_octocat", login: "octocat", avatarUrl: "https://avatars.test/octocat" };
	}

	async organizationMembership(_token: string, organization: string) {
		this.membershipCalls.push(organization);
		if (this.membershipFailure) throw this.membershipFailure;
		return this.membership;
	}

	async installations(_token: string, page: number): Promise<InstallationPage> {
		if (this.denyRepositories) throw new GitHubError("GitHub API rejected the request", 401);
		return {
			installations: [{
				id: "123",
				account: {
					login: "octo-org",
					avatarUrl: "https://avatars.test/octo-org",
					type: "organization",
				},
				repositorySelection: "selected",
				configureUrl: "https://github.test/settings/installations/123",
				suspended: false,
				permissions: {
					contents: true,
					pullRequests: true,
					checks: true,
					statuses: true,
				},
			}],
			nextPage: page + 1,
		};
	}

	async installationRepositories(
		_token: string,
		_installationId: string,
		page: number,
	): Promise<RepositoryPage> {
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

	async repositoryAccess(token: string, owner: string, name: string) {
		return (await this.installationRepositories(token, "123", 1)).repositories[0] && {
			...(await this.installationRepositories(token, "123", 1)).repositories[0]!,
			owner,
			name,
			fullName: `${owner}/${name}`,
		};
	}

	invalidate(token: string): void {
		this.invalidated.push(token);
	}

	private grant(accessToken: string, refreshToken: string): GitHubTokenGrant {
		return {
			accessToken,
			accessExpiresIn: 28_800,
			refreshToken,
			refreshExpiresIn: 15_897_600,
		};
	}
}

const CONFIG: AuthConfig = {
	origin: "https://chopin.test",
	appSlug: "chopin-test",
	clientId: "client-id",
	clientSecret: "client-secret",
	encryptionKey: new Uint8Array(32).fill(6),
};

async function callback(router: Router): Promise<Response> {
	let start = await router.handle(new Request("https://chopin.test/auth/github"));
	let state = new URL(start!.headers.get("location")!).searchParams.get("state");
	let stateCookie = pair(cookies(start!)[0]!);
	return (await router.handle(
		new Request(
			`https://chopin.test/auth/github/callback?code=code&state=${state}`,
			{ headers: { cookie: stateCookie } },
		),
	))!;
}

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
			installUrl: "/auth/github/install",
			user: { id: "U_octocat", login: "octocat", avatarUrl: "https://avatars.test/octocat" },
			expiresAt: "2026-09-12T12:00:00.000Z",
		});

		let installations = await router.handle(
			new Request("https://chopin.test/api/github/installations?page=3", {
				headers: { cookie: sessionCookie },
			}),
		);
		expect(installations!.status).toBe(200);
		expect((await installations!.json()).nextPage).toBe(4);
		let repositories = await router.handle(
			new Request("https://chopin.test/api/github/installations/123/repositories?page=3", {
				headers: { cookie: sessionCookie },
			}),
		);
		expect((await repositories!.json()).nextPage).toBe(4);

		let sessionId = sessionCookie.slice(sessionCookie.indexOf("=") + 1).split(".")[0]!;
		let stored = await storage.sessions.get(sessionId, now);
		expect(stored).toEqual({
			id: sessionId,
			userId: "U_octocat",
			expiresAt: new Date("2026-09-12T12:00:00.000Z"),
			createdAt: now,
		});
		let setup = await router.handle(
			new Request("https://chopin.test/auth/github/setup?installation_id=spoofed", {
				headers: { cookie: sessionCookie },
			}),
		);
		expect(setup!.status).toBe(303);
		expect(setup!.headers.get("location")).toBe("/");
		expect(github.invalidated).toEqual(["ghu_route_secret"]);

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

	it("redirects to the configured App installation page", async () => {
		let router = new Router();
		registerAuthRoutes(router, {
			config: CONFIG,
			storage: new MemoryStorage(),
			github: new FakeGitHub(),
		});
		let response = await router.handle(new Request("https://chopin.test/auth/github/install"));
		expect(response!.status).toBe(302);
		expect(response!.headers.get("location"))
			.toBe("https://github.com/apps/chopin-test/installations/new");
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

	it("admits the union of explicit users and active organization members", async () => {
		let explicitGitHub = new FakeGitHub();
		explicitGitHub.membershipFailure = new GitHubError("must not be queried", 500);
		let explicitRouter = new Router();
		registerAuthRoutes(explicitRouter, {
			config: {
				...CONFIG,
				allowedUsers: new Set(["octocat"]),
				allowedOrganizations: new Set(["githubnext"]),
			},
			storage: new MemoryStorage(),
			github: explicitGitHub,
		});
		expect((await callback(explicitRouter)).status).toBe(303);
		expect(explicitGitHub.membershipCalls).toEqual([]);

		let memberGitHub = new FakeGitHub();
		memberGitHub.membership = { state: "active", role: "member" };
		let memberRouter = new Router();
		registerAuthRoutes(memberRouter, {
			config: { ...CONFIG, allowedOrganizations: new Set(["githubnext"]) },
			storage: new MemoryStorage(),
			github: memberGitHub,
		});
		expect((await callback(memberRouter)).status).toBe(303);
		expect(memberGitHub.membershipCalls).toEqual(["githubnext"]);
	});

	it("refuses unlisted OAuth identities before persisting a user or session", async () => {
		let storage = new MemoryStorage();
		let github = new FakeGitHub();
		let router = new Router();
		registerAuthRoutes(router, {
			config: { ...CONFIG, allowedOrganizations: new Set(["githubnext"]) },
			storage,
			github,
		});

		let denied = await callback(router);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({
			error: "GitHub account is not allowed to use this Chopin instance",
		});
		expect(await storage.users.get("U_octocat")).toBeUndefined();
		expect(cookies(denied)).toHaveLength(1);
		expect(cookies(denied)[0]).toContain("Max-Age=0");
	});

	it("fails closed without persisting identity when organization verification is unavailable", async () => {
		let storage = new MemoryStorage();
		let github = new FakeGitHub();
		github.membershipFailure = new GitHubError("App permission is missing", 403);
		let router = new Router();
		registerAuthRoutes(router, {
			config: { ...CONFIG, allowedOrganizations: new Set(["githubnext"]) },
			storage,
			github,
		});

		let unavailable = await callback(router);
		expect(unavailable.status).toBe(503);
		expect(await storage.users.get("U_octocat")).toBeUndefined();
	});

	it("revokes an active browser session after organization membership is removed", async () => {
		let now = new Date("2026-08-13T12:00:00.000Z");
		let storage = new MemoryStorage();
		let github = new FakeGitHub();
		github.membership = { state: "active", role: "member" };
		let revoked: string[] = [];
		let router = new Router();
		registerAuthRoutes(router, {
			config: { ...CONFIG, allowedOrganizations: new Set(["githubnext"]) },
			storage,
			github,
			clock: () => now,
			onSessionRevoked: async id => {
				revoked.push(id);
			},
		});

		let signedIn = await callback(router);
		let sessionCookie = pair(
			cookies(signedIn).find(value => value.startsWith("__Host-chopin_session="))!,
		);
		let sessionId = sessionCookie.slice(sessionCookie.indexOf("=") + 1).split(".")[0]!;
		github.membership = undefined;
		now = new Date(now.getTime() + 30_000);
		let session = await router.handle(
			new Request("https://chopin.test/api/session", {
				headers: { cookie: sessionCookie },
			}),
		);

		expect(await session!.json()).toEqual({ user: null, agent: true });
		expect(await storage.sessions.get(sessionId, now)).toBeUndefined();
		expect(revoked).toEqual([sessionId]);
	});

	it("uses the configured public origin behind a reverse proxy", async () => {
		let config = { ...CONFIG, origin: "https://sample-vm.exe.xyz" };
		let github = new FakeGitHub();
		let router = new Router();
		registerAuthRoutes(router, { config, storage: new MemoryStorage(), github });
		let forwarded = {
			"x-forwarded-host": "evil.test",
			"x-forwarded-proto": "http",
		};

		let start = await router.handle(
			new Request("http://127.0.0.1:8787/auth/github", { headers: forwarded }),
		);
		expect(github.authorized).toMatchObject({
			clientId: "client-id",
			redirectUri: "https://sample-vm.exe.xyz/auth/github/callback",
		});
		let stateCookie = cookies(start!)[0]!;
		expect(stateCookie).toStartWith("__Host-chopin_oauth_state=");
		expect(stateCookie).toContain("; Secure");
		let state = new URL(start!.headers.get("location")!).searchParams.get("state");

		let callback = await router.handle(
			new Request(
				`http://127.0.0.1:8787/auth/github/callback?code=oauth-code&state=${state}`,
				{ headers: { ...forwarded, cookie: pair(stateCookie) } },
			),
		);
		expect(callback!.status).toBe(303);
		expect(github.exchanged).toMatchObject({
			clientId: "client-id",
			clientSecret: "client-secret",
			redirectUri: "https://sample-vm.exe.xyz/auth/github/callback",
			code: "oauth-code",
		});
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
			new Request("https://chopin.test/api/github/installations", {
				headers: { cookie: sessionCookie },
			}),
		);
		expect(denied!.status).toBe(401);
		expect(cookies(denied!)[0]).toContain("Max-Age=0");
		expect(await storage.sessions.get(sessionId, now)).toBeUndefined();
	});
});
