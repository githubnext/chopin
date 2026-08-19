import { describe, expect, it } from "bun:test";

import { GitHubClient, GitHubError, GitHubTokenError } from "./client";

function repository(id: string) {
	return {
		node_id: id,
		owner: { login: "octo-org" },
		name: "score",
		full_name: "octo-org/score",
		private: true,
		html_url: "https://github.test/octo-org/score",
		default_branch: "main",
		permissions: { pull: true, push: true, admin: false },
	};
}

function installation(id = 123) {
	return {
		id,
		account: {
			login: "octo-org",
			avatar_url: "https://avatars.test/octo-org",
			type: "Organization",
		},
		repository_selection: "selected",
		html_url: `https://github.test/settings/installations/${id}`,
		suspended_at: null,
		permissions: {
			contents: "read",
			pull_requests: "read",
			checks: "read",
			statuses: "read",
		},
	};
}

describe("the GitHub client", () => {
	it("builds an OAuth authorization URL with state and PKCE", () => {
		let client = new GitHubClient();
		let url = new URL(client.authorize({
			clientId: "client-id",
			redirectUri: "https://chopin.test/auth/github/callback",
			state: "state",
			challenge: "challenge",
		}));

		expect(url.origin).toBe("https://github.com");
		expect(url.searchParams.get("client_id")).toBe("client-id");
		expect(url.searchParams.get("redirect_uri"))
			.toBe("https://chopin.test/auth/github/callback");
		expect(url.searchParams.has("scope")).toBe(false);
		expect(url.searchParams.get("state")).toBe("state");
		expect(url.searchParams.get("code_challenge")).toBe("challenge");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	});

	it("exchanges a code without putting the client secret in the URL", async () => {
		let called: { url: string; init?: RequestInit } | undefined;
		let client = new GitHubClient({
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				called = { url: String(input), init };
				return Response.json({
					access_token: "ghu_user",
					expires_in: 28_800,
					refresh_token: "ghr_refresh",
					refresh_token_expires_in: 15_897_600,
					token_type: "bearer",
				});
			}),
			endpoints: { token: "https://github.test/token" },
		});

		expect(
			await client.exchange({
				clientId: "client-id",
				clientSecret: "client-secret",
				redirectUri: "https://chopin.test/auth/github/callback",
				code: "code",
				verifier: "verifier",
			}),
		).toEqual({
			accessToken: "ghu_user",
			accessExpiresIn: 28_800,
			refreshToken: "ghr_refresh",
			refreshExpiresIn: 15_897_600,
		});
		expect(called!.url).toBe("https://github.test/token");
		expect(called!.url).not.toContain("client-secret");
		let body = new URLSearchParams(called!.init!.body as string);
		expect(body.get("client_secret")).toBe("client-secret");
		expect(body.get("redirect_uri")).toBe("https://chopin.test/auth/github/callback");
		expect(body.get("code_verifier")).toBe("verifier");
		expect(called!.init!.redirect).toBe("error");
	});

	it("rotates an expiring user token", async () => {
		let body: URLSearchParams | undefined;
		let client = new GitHubClient({
			fetch: async (_input, init) => {
				body = new URLSearchParams(init!.body as string);
				return Response.json({
					access_token: "ghu_next",
					expires_in: 28_800,
					refresh_token: "ghr_next",
					refresh_token_expires_in: 15_897_600,
					token_type: "bearer",
				});
			},
			endpoints: { token: "https://github.test/token" },
		});

		expect(
			await client.refresh({
				clientId: "client-id",
				clientSecret: "client-secret",
				refreshToken: "ghr_current",
			}),
		).toMatchObject({ accessToken: "ghu_next", refreshToken: "ghr_next" });
		expect(body!.get("grant_type")).toBe("refresh_token");
		expect(body!.get("refresh_token")).toBe("ghr_current");
	});

	it("requires expiring grants and identifies a rejected refresh token", async () => {
		let incomplete = new GitHubClient({
			fetch: async () => Response.json({ access_token: "ghu_user", token_type: "bearer" }),
			endpoints: { token: "https://github.test/token" },
		});
		await expect(incomplete.exchange({
			clientId: "client-id",
			clientSecret: "client-secret",
			redirectUri: "https://chopin.test/auth/github/callback",
			code: "code",
			verifier: "verifier",
		})).rejects.toThrow("invalid expiring user token");

		let rejected = new GitHubClient({
			fetch: async () => Response.json({ error: "bad_refresh_token" }),
			endpoints: { token: "https://github.test/token" },
		});
		try {
			await rejected.refresh({
				clientId: "client-id",
				clientSecret: "client-secret",
				refreshToken: "ghr_bad",
			});
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(GitHubTokenError);
			expect((err as GitHubTokenError).terminal).toBe(true);
			expect((err as GitHubTokenError).status).toBe(401);
		}
	});

	it("normalizes the user, installations and installation repositories", async () => {
		let requests: Array<{ url: URL; authorization: string | null }> = [];
		let client = new GitHubClient({
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				let url = new URL(String(input));
				let headers = new Headers(init?.headers);
				requests.push({ url, authorization: headers.get("authorization") });
				if (url.pathname === "/user") {
					return Response.json({ node_id: "U_octocat", login: "octocat", avatar_url: "avatar" });
				}
				if (url.pathname === "/user/installations") {
					return Response.json({ installations: [installation()] }, {
						headers: {
							link: '<https://api.test/user/installations?page=2&per_page=100>; rel="next"',
						},
					});
				}
				return Response.json({ repositories: [repository("R_score")] }, {
					headers: {
						link:
							'<https://api.test/user/installations/123/repositories?page=2&per_page=100>; rel="next"',
					},
				});
			}),
			endpoints: { api: "https://api.test" },
		});

		expect(await client.user("ghu_user")).toEqual({
			id: "U_octocat",
			login: "octocat",
			avatarUrl: "avatar",
		});
		let installations = await client.installations("ghu_user", 1);
		expect(installations.installations[0]).toMatchObject({
			id: "123",
			account: { login: "octo-org", type: "organization" },
			repositorySelection: "selected",
			suspended: false,
			permissions: { contents: true, pullRequests: true, checks: true, statuses: true },
		});
		expect(installations.nextPage).toBe(2);
		let page = await client.installationRepositories("ghu_user", "123", 1);
		expect(page.repositories).toEqual([{
			id: "R_score",
			owner: "octo-org",
			name: "score",
			fullName: "octo-org/score",
			private: true,
			url: "https://github.test/octo-org/score",
			defaultBranch: "main",
			permissions: { pull: true, push: true, admin: false },
		}]);
		expect(page.nextPage).toBe(2);
		expect(requests.every(request => request.authorization === "Bearer ghu_user")).toBe(true);
	});

	it("resolves active, pending, and absent organization membership", async () => {
		let requested: string[] = [];
		let client = new GitHubClient({
			fetch: async input => {
				let url = new URL(String(input));
				requested.push(url.pathname);
				if (url.pathname.endsWith("/missing")) {
					return Response.json({ message: "Not Found" }, { status: 404 });
				}
				return Response.json({
					state: url.pathname.endsWith("/pending") ? "pending" : "active",
					role: "member",
				});
			},
			endpoints: { api: "https://api.test" },
		});

		expect(await client.organizationMembership("token", "GitHubNext")).toEqual({
			state: "active",
			role: "member",
		});
		expect(await client.organizationMembership("token", "pending")).toEqual({
			state: "pending",
			role: "member",
		});
		expect(await client.organizationMembership("token", "missing")).toBeUndefined();
		expect(requested).toEqual([
			"/user/memberships/orgs/GitHubNext",
			"/user/memberships/orgs/pending",
			"/user/memberships/orgs/missing",
		]);
	});

	it("rejects malformed organization membership responses", async () => {
		let client = new GitHubClient({
			fetch: async () => Response.json({ state: "active", role: "outsider" }),
			endpoints: { api: "https://api.test" },
		});
		await expect(client.organizationMembership("token", "githubnext"))
			.rejects.toThrow("invalid organization membership");
	});

	it("grants channel access only through an active installation repository listing", async () => {
		let requests = 0;
		let now = 0;
		let client = new GitHubClient({
			fetch: async input => {
				requests++;
				let url = new URL(String(input));
				if (url.pathname === "/user/installations") {
					return Response.json({ installations: [installation()] });
				}
				if (url.searchParams.get("page") === "1") {
					return Response.json({ repositories: [] }, {
						headers: {
							link: '<https://api.test/user/installations/123/repositories?page=2>; rel="next"',
						},
					});
				}
				if (url.searchParams.get("page") === "2") {
					return Response.json({ repositories: [repository("R_score")] }, {
						headers: {
							link: '<https://api.test/user/installations/123/repositories?page=3>; rel="next"',
						},
					});
				}
				return Response.json({ repositories: [] });
			},
			endpoints: { api: "https://api.test" },
			clock: () => now,
		});
		expect((await client.repositoryAccess("ghu_user", "octo-org", "score"))?.id)
			.toBe("R_score");
		let afterFirst = requests;
		expect((await client.repositoryAccess("ghu_user", "octo-org", "score"))?.id)
			.toBe("R_score");
		expect(requests).toBe(afterFirst);
		now = 60_001;
		expect((await client.repositoryAccess("ghu_user", "octo-org", "score"))?.id)
			.toBe("R_score");
		expect(requests).toBeGreaterThan(afterFirst);
		let afterExpiry = requests;
		client.invalidate("ghu_user");
		expect((await client.repositoryAccess("ghu_user", "octo-org", "score"))?.id)
			.toBe("R_score");
		expect(requests).toBeGreaterThan(afterExpiry);
		expect(await client.repositoryAccess("ghu_user", "octo-org", "public-but-unaffiliated"))
			.toBeUndefined();
	});

	it("rejects malformed or unsuccessful provider responses", async () => {
		let client = new GitHubClient({
			fetch: async () => Response.json({ login: "missing id" }),
			endpoints: { api: "https://api.test" },
		});
		await expect(client.user("ghu_user")).rejects.toBeInstanceOf(GitHubError);

		let denied = new GitHubClient({
			fetch: async () => Response.json({ message: "denied" }, { status: 401 }),
			endpoints: { api: "https://api.test" },
		});
		try {
			await denied.user("ghu_user");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(GitHubError);
			expect((err as GitHubError).status).toBe(401);
		}
	});
});
