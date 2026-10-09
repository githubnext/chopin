import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class ConnectorError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

export async function remote(origin: string, token: string) {
	let client = new Client({ name: "chopin-connector", version: "0.1.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("/connector/mcp", origin), {
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		}),
	);
	return {
		close: () => client.close(),
		tools: () => client.listTools(),
		invoke: (name: string, args: Record<string, unknown> = {}) =>
			client.callTool({ name, arguments: args }),
		async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
			let response = await client.callTool({ name, arguments: args }, undefined, {
				timeout: 45_000,
				signal,
			});
			if (response.isError) {
				let message = (response.content as Array<{ type: string; text?: string }>).find(item =>
					item.type === "text"
				)?.text ?? "Connector tool failed";
				throw new ConnectorError(
					message.match(/^([a-z][a-z0-9-]+):/)?.[1] ?? "unavailable",
					message,
				);
			}
			let content = response.content as Array<{ type: string; text?: string }>;
			let text = content.find(item => item.type === "text")?.text;
			if (!text) throw new Error("Missing connector response.");
			return JSON.parse(text) as unknown;
		},
	};
}
