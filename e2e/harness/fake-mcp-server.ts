/**
 * Implements the legacy JSON-RPC handshake (`initialize`, `notifications/initialized`,
 * `tools/list`, `tools/call`) that `@ai-sdk/mcp`'s HTTP transport falls back to once
 * `server/discover` answers "method not found". Advertises one extra `search_code`
 * tool that Chopin's allowlist must never load.
 *
 * Calls are recorded and exposed over `GET /__calls__` on the same fixed port,
 * because the Playwright test runs in a separate process from the server this
 * fake lives inside. Only header presence/shape is recorded, never the token.
 */
import { FAKE_MCP_PORT, PULL_REQUESTS } from "./fixtures";

type RecordedCall = {
	method: string;
	toolName?: string;
	arguments?: unknown;
	hasBearer: boolean;
	readonly: string | null;
	toolsets: string | null;
};

function jsonRpc(id: unknown, body: Record<string, unknown>): Response {
	return Response.json({ jsonrpc: "2.0", id, ...body }, {
		headers: { "content-type": "application/json" },
	});
}

function result(id: unknown, value: unknown): Response {
	return jsonRpc(id, { result: value });
}

function error(id: unknown, code: number, message: string): Response {
	return jsonRpc(id, { error: { code, message } });
}

function textResult(text: string): { content: { type: "text"; text: string }[] } {
	return { content: [{ type: "text", text }] };
}

export function startFakeGithubMcpServer(): { url: string; stop: () => void } {
	let calls: RecordedCall[] = [];

	let server = Bun.serve({
		port: FAKE_MCP_PORT,
		hostname: "127.0.0.1",
		async fetch(request) {
			let url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/__calls__") {
				return Response.json(calls);
			}
			if (request.method !== "POST") return new Response("Not found", { status: 404 });

			let body = await request.json() as {
				id?: unknown;
				method: string;
				params?: Record<string, unknown>;
			};
			let authorization = request.headers.get("authorization") ?? "";
			calls.push({
				method: body.method,
				toolName: typeof body.params?.name === "string" ? body.params.name : undefined,
				arguments: body.params?.arguments,
				hasBearer: authorization.startsWith("Bearer ghu_e2e_"),
				readonly: request.headers.get("x-mcp-readonly"),
				toolsets: request.headers.get("x-mcp-toolsets"),
			});

			switch (body.method) {
				case "server/discover":
					// Not implemented: the client falls back to the legacy handshake below.
					return error(body.id, -32601, "Method not found");
				case "initialize":
					return result(body.id, {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "fake-github-mcp", version: "0.0.0" },
					});
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				case "tools/list":
					return result(body.id, {
						tools: [
							{
								name: "list_pull_requests",
								description: "List pull requests.",
								inputSchema: { type: "object", properties: {} },
							},
							{
								name: "pull_request_read",
								description: "Read a pull request.",
								inputSchema: { type: "object", properties: {} },
							},
							{
								name: "search_code",
								description: "Search code across GitHub. Not in Chopin's allowlist.",
								inputSchema: { type: "object", properties: {} },
							},
						],
					});
				case "tools/call": {
					let name = body.params?.name;
					if (name === "list_pull_requests") {
						return result(body.id, textResult(JSON.stringify(PULL_REQUESTS)));
					}
					if (name === "pull_request_read") {
						let [pull] = PULL_REQUESTS;
						return result(body.id, textResult(JSON.stringify(pull ?? null)));
					}
					return error(body.id, -32601, `Unknown tool ${String(name)}`);
				}
				default:
					return error(body.id, -32601, `Unsupported method ${body.method}`);
			}
		},
	});

	return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}
