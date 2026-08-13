/**
 * Fake only GitHub's network boundary. OAuth state, PKCE, encrypted sessions,
 * channel authorization and WebSocket admission still run in the real server.
 */
let network = globalThis.fetch;

const repository = {
	node_id: "R_score",
	owner: { login: "octo-org" },
	name: "score",
	full_name: "octo-org/score",
	private: true,
	html_url: "https://github.com/octo-org/score",
	default_branch: "main",
	permissions: { pull: true, push: true, admin: false },
};

function json(value: unknown, init: ResponseInit = {}): Response {
	return Response.json(value, init);
}

let fake = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	let url = new URL(input instanceof Request ? input.url : input);
	if (url.href === "https://github.com/login/oauth/access_token") {
		let body = new URLSearchParams(String(init?.body ?? ""));
		return json({ access_token: `e2e-token-${body.get("code") ?? "person"}` });
	}
	if (url.origin === "https://api.github.com") {
		let authorization = new Headers(init?.headers).get("authorization") ?? "";
		let handle = authorization.replace(/^Bearer e2e-token-e2e-/, "") || "person";
		if (url.pathname === "/user") {
			return json({
				node_id: `U_${handle}`,
				login: handle,
				avatar_url: `https://example.invalid/${handle}.png`,
			});
		}
		if (url.pathname === "/user/repos") return json([repository]);
		if (url.pathname === "/repos/octo-org/score") return json(repository);
		return json({ message: "Not Found" }, { status: 404 });
	}
	return network(input, init);
};
globalThis.fetch = Object.assign(fake, { preconnect: network.preconnect });
