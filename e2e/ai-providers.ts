let network = globalThis.fetch;

const MODEL_LISTS = new Set([
	"https://api.openai.com/v1/models",
	"https://api.anthropic.com/v1/models",
]);

function presentedKey(init?: RequestInit): string {
	let headers = new Headers(init?.headers);
	return headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

let fake = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	let url = new URL(input instanceof Request ? input.url : input);
	if (!MODEL_LISTS.has(`${url.origin}${url.pathname}`)) return network(input, init);
	return presentedKey(init).startsWith("sk-e2e-refused")
		? Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 })
		: Response.json({ data: [] });
};

globalThis.fetch = Object.assign(fake, { preconnect: network.preconnect });
