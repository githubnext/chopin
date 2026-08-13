import { describe, expect, it } from "bun:test";

import { GitHubClient, GitHubError } from "./client";

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
		expect(url.searchParams.get("scope")).toBe("read:user repo");
		expect(url.searchParams.get("state")).toBe("state");
		expect(url.searchParams.get("code_challenge")).toBe("challenge");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	});

	it("exchanges a code without putting the client secret in the URL", async () => {
		let called: { url: string; init?: RequestInit } | undefined;
		let client = new GitHubClient({
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				called = { url: String(input), init };
				return Response.json({ access_token: "gho_user", token_type: "bearer" });
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
		).toBe("gho_user");
		expect(called!.url).toBe("https://github.test/token");
		expect(called!.url).not.toContain("client-secret");
		let body = new URLSearchParams(called!.init!.body as string);
		expect(body.get("client_secret")).toBe("client-secret");
		expect(body.get("code_verifier")).toBe("verifier");
		expect(called!.init!.redirect).toBe("error");
	});

	it("normalizes the user and one repository page", async () => {
		let requests: Array<{ url: URL; authorization: string | null }> = [];
		let client = new GitHubClient({
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				let url = new URL(String(input));
				let headers = new Headers(init?.headers);
				requests.push({ url, authorization: headers.get("authorization") });
				if (url.pathname === "/user") {
					return Response.json({ node_id: "U_octocat", login: "octocat", avatar_url: "avatar" });
				}
				return Response.json([repository("R_score")], {
					headers: {
						link: '<https://api.test/user/repos?page=2&per_page=100>; rel="next"',
					},
				});
			}),
			endpoints: { api: "https://api.test" },
		});

		expect(await client.user("gho_user")).toEqual({
			id: "U_octocat",
			login: "octocat",
			avatarUrl: "avatar",
		});
		let page = await client.repositories("gho_user", 1);
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
		expect(requests.every(request => request.authorization === "Bearer gho_user")).toBe(true);
		expect(requests[1]!.url.searchParams.get("affiliation"))
			.toBe("owner,collaborator,organization_member");
	});

	it("rejects malformed or unsuccessful provider responses", async () => {
		let client = new GitHubClient({
			fetch: async () => Response.json({ login: "missing id" }),
			endpoints: { api: "https://api.test" },
		});
		await expect(client.user("gho_user")).rejects.toBeInstanceOf(GitHubError);

		let denied = new GitHubClient({
			fetch: async () => Response.json({ message: "denied" }, { status: 401 }),
			endpoints: { api: "https://api.test" },
		});
		try {
			await denied.user("gho_user");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(GitHubError);
			expect((err as GitHubError).status).toBe(401);
		}
	});
});
