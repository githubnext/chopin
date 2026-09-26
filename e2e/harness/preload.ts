/**
 * Installs the fake `HarnessV1` into the shipped, extensible `harnesses` map
 * and routes only the exact external GitHub MCP URL to a local fake HTTP
 * server. Everything else stays production code.
 *
 * Loaded after `e2e/github.ts` on the command line, so this fetch wrapper
 * sits under that one and only the MCP URL is intercepted here.
 */
import { harnesses } from "../../apps/server/src/harness/harnesses";
import { startFakeGithubMcpServer } from "./fake-mcp-server";
import { createFakeHarness } from "./fake-harness";

export const HARNESS_NAME = "e2e-fake";

(harnesses as Record<string, unknown>)[HARNESS_NAME] = createFakeHarness;

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

let mcp = startFakeGithubMcpServer();
let network = globalThis.fetch;

let fake = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	let url = new URL(input instanceof Request ? input.url : input);
	if (url.href === GITHUB_MCP_URL) {
		let headers = new Headers(input instanceof Request ? input.headers : init?.headers);
		let body = input instanceof Request ? await input.clone().arrayBuffer() : init?.body;
		return network(mcp.url, { method: init?.method ?? "POST", headers, body });
	}
	return network(input, init);
};
globalThis.fetch = Object.assign(fake, { preconnect: network.preconnect });
