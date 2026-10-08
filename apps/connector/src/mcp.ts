import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function remote(origin: string, token: string) {
	let client = new Client({ name: "chopin-connector", version: "0.1.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("/connector/mcp", origin), {
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		}),
	);
	return {
		close: () => client.close(),
		async call(name: string, args: Record<string, unknown> = {}) {
			let response = await client.callTool({ name, arguments: args }, undefined, {
				timeout: 45_000,
			});
			if (response.isError) throw new Error(JSON.stringify(response.content));
			let content = response.content as Array<{ type: string; text?: string }>;
			let text = content.find(item => item.type === "text")?.text;
			if (!text) throw new Error("Missing connector response.");
			return JSON.parse(text) as unknown;
		},
	};
}
