import { ROOT } from "../servers";
import { registerScriptedHarness } from "./scripted-register";

await registerScriptedHarness(process.env, ROOT);
let { startFakeGithubMcpServer } = await import("./fake-mcp-server");

let mcp = startFakeGithubMcpServer();
let network = globalThis.fetch;

// Loaded after the GitHub and Jev preloads; unknown URLs retain their existing wrappers.
let fake = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	let request = input instanceof Request ? input : undefined;
	let url = new URL(request ? request.url : input as string | URL);
	if (url.href === "https://api.githubcopilot.com/mcp/") {
		let headers = new Headers(init?.headers ?? request?.headers);
		let body = init?.body !== undefined
			? init.body
			: request
			? await request.clone().arrayBuffer()
			: undefined;
		return network(mcp.url, {
			...init,
			method: init?.method ?? request?.method ?? "POST",
			headers,
			body,
			signal: init?.signal !== undefined ? init.signal : request?.signal,
		});
	}
	return network(input, init);
};
globalThis.fetch = Object.assign(fake, { preconnect: network.preconnect });
