/**
 * Fake only GitHub's network boundary. OAuth state, PKCE, process-local sessions,
 * channel authorization and WebSocket admission still run in the real server.
 */
let network = globalThis.fetch;

const repositories = [
	{
		node_id: "R_score",
		owner: { login: "octo-org" },
		name: "score",
		full_name: "octo-org/score",
		private: true,
		html_url: "https://github.com/octo-org/score",
		default_branch: "main",
		permissions: { pull: true, push: true, admin: false },
	},
	{
		node_id: "R_notes",
		owner: { login: "octocat" },
		name: "notes",
		full_name: "octocat/notes",
		private: false,
		html_url: "https://github.com/octocat/notes",
		default_branch: "main",
		permissions: { pull: true, push: false, admin: false },
	},
	...Array.from({ length: 12 }, (_, index) => ({
		node_id: `R_archive_${index + 1}`,
		owner: { login: "octo-org" },
		name: `archive-${index + 1}`,
		full_name: `octo-org/archive-${index + 1}`,
		private: false,
		html_url: `https://github.com/octo-org/archive-${index + 1}`,
		default_branch: "main",
		permissions: { pull: true, push: false, admin: false },
	})),
];

const installations = [
	{
		id: 101,
		account: {
			login: "octo-org",
			avatar_url: "https://example.invalid/octo-org.png",
			type: "Organization",
		},
		repository_selection: "selected",
		html_url: "https://github.com/settings/installations/101",
		suspended_at: null,
		permissions: { contents: "read", pull_requests: "read", checks: "read", statuses: "read" },
	},
	{
		id: 102,
		account: {
			login: "octocat",
			avatar_url: "https://example.invalid/octocat.png",
			type: "User",
		},
		repository_selection: "selected",
		html_url: "https://github.com/settings/installations/102",
		suspended_at: null,
		permissions: { contents: "read", pull_requests: "read", checks: "read", statuses: "read" },
	},
];

function json(value: unknown, init: ResponseInit = {}): Response {
	return Response.json(value, init);
}

let fake = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	let url = new URL(input instanceof Request ? input.url : input);
	if (url.href === "https://github.com/login/oauth/access_token") {
		let body = new URLSearchParams(String(init?.body ?? ""));
		let refreshing = body.get("grant_type") === "refresh_token";
		let refreshed = /^ghr_e2e_(.+)_(\d+)$/.exec(body.get("refresh_token") ?? "");
		if (refreshing && !refreshed) return json({ error: "bad_refresh_token" });
		let handle = refreshing
			? refreshed![1]!
			: (body.get("code") ?? "e2e-person").replace(/^e2e-/, "");
		if (refreshing && handle === "expired") return json({ error: "bad_refresh_token" });
		let revision = refreshing ? Number(refreshed![2]) + 1 : 1;
		return json({
			access_token: `ghu_e2e_${handle}_${revision}`,
			expires_in: 28_800,
			refresh_token: `ghr_e2e_${handle}_${revision}`,
			refresh_token_expires_in: 15_897_600,
			token_type: "bearer",
		});
	}
	if (url.origin === "https://api.github.com") {
		let authorization = new Headers(init?.headers).get("authorization") ?? "";
		let authorized = /^Bearer ghu_e2e_(.+)_\d+$/.exec(authorization);
		if (!authorized) return json({ message: "Bad credentials" }, { status: 401 });
		let handle = authorized[1]!;
		if (url.pathname === "/user") {
			return json({
				node_id: `U_${handle}`,
				login: handle,
				avatar_url: `https://example.invalid/${handle}.png`,
			});
		}
		if (url.pathname === "/user/memberships/orgs/githubnext") {
			if (handle === "outsider") return json({ message: "Not Found" }, { status: 404 });
			return json({
				state: handle === "pending" ? "pending" : "active",
				role: "member",
			});
		}
		if (handle === "expired") return json({ message: "Bad credentials" }, { status: 401 });
		if (url.pathname === "/user/installations") {
			return json({ installations });
		}
		if (url.pathname === "/user/installations/101/repositories") {
			let available = repositories.filter(value => value.owner.login === "octo-org");
			if (handle === "paged" && url.searchParams.get("page") !== "2") {
				return json({ repositories: available.slice(0, 1) }, {
					headers: {
						link:
							'<https://api.github.com/user/installations/101/repositories?per_page=100&page=2>; rel="next"',
					},
				});
			}
			return json({ repositories: handle === "paged" ? available.slice(1) : available });
		}
		if (url.pathname === "/user/installations/102/repositories") {
			return json({ repositories: repositories.filter(value => value.owner.login === "octocat") });
		}
		let repository = repositories.find(value => url.pathname === `/repos/${value.full_name}`);
		if (repository) return json(repository);
		return json({ message: "Not Found" }, { status: 404 });
	}
	return network(input, init);
};
globalThis.fetch = Object.assign(fake, { preconnect: network.preconnect });
