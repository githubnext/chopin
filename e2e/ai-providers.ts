let network = globalThis.fetch;

const MODEL_LISTS = new Set([
	"https://api.openai.com/v1/models",
	"https://api.anthropic.com/v1/models",
]);

const CHATGPT_TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
const CLAUDE_TOKEN = "https://platform.claude.com/v1/oauth/token";

function presentedKey(init?: RequestInit): string {
	let headers = new Headers(init?.headers);
	return headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

function issued(provider: string, extra: Record<string, unknown> = {}) {
	return Response.json({
		access_token: `e2e-${provider}-access-${crypto.randomUUID()}`,
		refresh_token: `e2e-${provider}-refresh-${crypto.randomUUID()}`,
		expires_in: 3600,
		...extra,
	});
}

function signInToken(endpoint: string, init?: RequestInit): Response {
	let body = init?.body;
	let fields = endpoint === CHATGPT_TOKEN
		? Object.fromEntries(new URLSearchParams(String(body)))
		: JSON.parse(String(body)) as Record<string, string>;
	let accepted = fields.grant_type === "refresh_token"
		|| fields.code === "e2e-chatgpt-code"
		|| fields.code === "e2e-claude-code";
	if (!accepted) return Response.json({ error: "invalid_grant" }, { status: 400 });
	return endpoint === CHATGPT_TOKEN
		? issued("chatgpt", {
			id_token: "e2e-chatgpt-id-token",
			scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
		})
		: issued("claude");
}

let fake = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	let url = new URL(input instanceof Request ? input.url : input);
	let endpoint = `${url.origin}${url.pathname}`;
	if (endpoint === CHATGPT_TOKEN || endpoint === CLAUDE_TOKEN) return signInToken(endpoint, init);
	if (!MODEL_LISTS.has(endpoint)) return network(input, init);
	return presentedKey(init).startsWith("sk-e2e-refused")
		? Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 })
		: Response.json({ data: [] });
};

globalThis.fetch = Object.assign(fake, { preconnect: network.preconnect });
