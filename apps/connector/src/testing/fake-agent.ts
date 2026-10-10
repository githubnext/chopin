import { AgentApp, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { performance } from "@chopin/experiment/fixtures";
import type { McpServer } from "@agentclientprotocol/sdk";

let servers: McpServer[] = [];
let cwd = "";
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
		cwd = input.cwd;
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
		if (process.argv.includes("--spike")) {
			if (!config || !("url" in config) || !config.url.startsWith("http://127.0.0.1:")) {
				throw new Error("Expected a loopback HTTP bridge");
			}
			let anonymous = await fetch(config.url, { method: "POST", body: "{}" });
			if (anonymous.status !== 401) throw new Error(`Unauthenticated bridge: ${anonymous.status}`);
			let png = Buffer.from("89504e470d0a1a0a", "hex");
			await writeFile(join(cwd, "shot.png"), png);
			await writeFile(join(cwd, "..", "outside.png"), png);
			let bridge = new Client({ name: "fake-spiker", version: "1" });
			await bridge.connect(
				new StreamableHTTPClientTransport(new URL(config.url), {
					requestInit: {
						headers: Object.fromEntries(config.headers.map(item => [item.name, item.value])),
					},
				}),
			);
			try {
				let shot = await bridge.callTool({
					name: "upload_image_file",
					arguments: { path: "shot.png" },
				});
				if (shot.isError) throw new Error(JSON.stringify(shot.content));
				let escape = await bridge.callTool({
					name: "upload_image_file",
					arguments: { path: "../outside.png" },
				});
				if (!escape.isError) throw new Error("Uploaded a file outside the worktree");
				await bridge.callTool({ name: "submit_spike_result", arguments: { url: config.url } });
			} finally {
				await bridge.close();
			}
			return { stopReason: "end_turn" as const };
		}
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
