import { AgentApp, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { McpServer } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.argv.includes("--fail-start")) process.exit(1);

let servers: McpServer[] = [];
let app = new AgentApp()
	.onRequest(
		"initialize",
		() => ({
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: process.argv.includes("--http") ? { mcpCapabilities: { http: true } } : {},
		}),
	)
	.onRequest("session/new", ({ params }) => {
		servers = params.mcpServers;
		return { sessionId: "implementation-acp-session" };
	})
	.onRequest("session/prompt", async ({ params }) => {
		if (
			!params.prompt.some(part => part.type === "text" && part.text.includes("MUST use sub-agents"))
		) {
			throw new Error("Orchestration instruction missing");
		}
		let config = servers.find(server => server.name === "chopin-implementation");
		if (!config || !("command" in config || "url" in config)) {
			throw new Error("Implementation bridge missing");
		}
		let client = new Client({ name: "fixture-implementer", version: "1" });
		await client.connect(
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
		let call = async (name: string, args: Record<string, unknown> = {}) => {
			let result = await client.callTool({ name, arguments: args });
			if (result.isError) throw new Error(JSON.stringify(result.content));
			return result;
		};
		try {
			let read = await call("read_implementation");
			let context = JSON.parse((read.content as Array<{ text: string }>)[0].text);
			if (!context.document.url || !context.run.id) throw new Error("Trace context missing");
			if (process.argv.includes("--complete")) {
				for (let [index, task] of context.graph.definition.tasks.entries()) {
					await call("start_task", { taskId: task.id, idempotencyKey: `start-${task.id}` });
					await call("report_pr", {
						taskId: task.id,
						idempotencyKey: `pr-${task.id}`,
						url: `https://github.com/octo-org/score/pull/${101 + index}`,
						state: "open",
					});
					await call("complete_task", {
						taskId: task.id,
						idempotencyKey: `complete-${task.id}`,
						summary: "Protocol fixture complete",
					});
				}
				await call("report_verification", {
					passed: true,
					summary: "Protocol fixture verified",
					reviewerMethod: "Scripted integration fixture",
					evidence: context.graph.definition.tasks.map((task: { id: string }) => ({
						taskId: task.id,
						evidence: ["Scripted fixture exercised task reporting"],
					})),
					tasksNeedingWork: [],
					idempotencyKey: "verification",
				});
			} else {
				await call("start_task", { taskId: "connect", idempotencyKey: "start-connect" });
				await call("block_task", {
					taskId: "connect",
					idempotencyKey: "block-connect",
					reason: "Choose the next tracer",
				});
			}
		} finally {
			await client.close();
		}
		return { stopReason: "end_turn" as const };
	});
app.connect(ndJsonStream(
	Writable.toWeb(process.stdout),
	Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
));
