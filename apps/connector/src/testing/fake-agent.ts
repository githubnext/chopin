import { AgentApp, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { performance } from "@chopin/experiment/fixtures";
import type { McpServer } from "@agentclientprotocol/sdk";

let servers: McpServer[] = [];
let cancelled = false;
let release: (() => void) | undefined;

let app = new AgentApp()
	.onRequest(
		"initialize",
		() => ({
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: process.argv.includes("--http") ? { mcpCapabilities: { http: true } } : {},
		}),
	)
	.onRequest("session/new", ({ params: input }) => {
		servers = input.mcpServers;
		if (!input.cwd.startsWith("/")) throw new Error("Expected absolute cwd");
		return { sessionId: "test-session" };
	})
	.onRequest("session/prompt", async ({ params: input, client }) => {
		let stopped = new Promise<void>(resolve => {
			release = resolve;
		});
		await client.notify("session/update", {
			sessionId: input.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Inspecting the checkout" },
			},
		});
		if (process.argv.includes("--hold")) {
			if (!cancelled) await stopped;
			return { stopReason: "cancelled" as const };
		}
		let config = servers.find(server => server.name === "chopin-investigation");
		if (config && ("command" in config || "url" in config)) {
			let bridge = new Client({ name: "fake-investigator", version: "1" });
			await bridge.connect(
				"command" in config
					? new StdioClientTransport({
						command: config.command,
						args: config.args,
						env: Object.fromEntries(config.env.map(item => [item.name, item.value])),
					})
					: new StreamableHTTPClientTransport(new URL(config.url), {
						requestInit: {
							headers: Object.fromEntries(config.headers.map(item => [item.name, item.value])),
						},
					}),
			);
			try {
				await bridge.callTool({ name: "read_investigation", arguments: {} });
				let result = await bridge.callTool({
					name: "submit_investigation_result",
					arguments: { result: performance },
				});
				if (result.isError) throw new Error("Result submission failed");
			} finally {
				await bridge.close();
			}
		}
		return { stopReason: "end_turn" as const };
	})
	.onNotification("session/cancel", () => {
		cancelled = true;
		release?.();
	});
app.connect(
	ndJsonStream(
		Writable.toWeb(process.stdout),
		Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
	),
);
