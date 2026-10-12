import { AgentApp, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { McpServer } from "@agentclientprotocol/sdk";
import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.argv.includes("--fail-start")) process.exit(1);

let servers: McpServer[] = [];
let cwd = "";
let cancelled = () => {};
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
		cwd = params.cwd;
		return { sessionId: "implementation-acp-session" };
	})
	.onNotification("session/cancel", () => cancelled())
	.onRequest("session/prompt", async ({ params }) => {
		if (process.argv.includes("--orphan")) {
			// A dev server in its own process group, as `vite &` from an agent's shell tool is.
			let server = spawn("sleep", ["600"], { cwd, detached: true, stdio: "ignore" });
			server.unref();
			await writeFile(process.env.CHOPIN_TEST_ORPHAN_PID!, String(server.pid));
			return { stopReason: "end_turn" as const };
		}
		if (process.argv.includes("--hang")) {
			await new Promise<void>(resolve => cancelled = resolve);
			return { stopReason: "cancelled" as const };
		}
		if (process.argv.includes("--rebuild")) {
			let text = params.prompt.map(part => part.type === "text" ? part.text : "").join("\n");
			if (!text.includes("read_rebuild") || text.includes("MUST use sub-agents")) {
				throw new Error("Rebuild instruction missing");
			}
			let branch = spawnSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" });
			if (branch.stdout.trim()) throw new Error(`Rebuild started on a branch: ${branch.stdout}`);
			// Outlive a heartbeat, as an agent finishing its turn after report_rebuild does.
			if (process.argv.includes("--slow")) await new Promise(resolve => setTimeout(resolve, 200));
			return { stopReason: "end_turn" as const };
		}
		if (process.argv.includes("--live")) {
			let text = params.prompt.map(part => part.type === "text" ? part.text : "").join("\n");
			if (
				!text.includes("ends at the last complete_task") || text.includes("report_verification")
				|| text.includes("request_revision")
			) throw new Error("Live instruction missing");
			return { stopReason: "end_turn" as const };
		}
		let rebuilding = process.argv.includes("--complete")
			&& params.prompt.some(part => part.type === "text" && part.text.includes("read_rebuild"));
		if (
			!rebuilding
			&& !params.prompt.some(part =>
				part.type === "text" && part.text.includes("MUST use sub-agents")
			)
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
		// A completing fixture lands a rebuild with one commit on the first pull request.
		if (rebuilding) {
			try {
				let read = await call("read_rebuild");
				let delta = JSON.parse((read.content as Array<{ text: string }>)[0].text);
				let pullRequest = delta.pullRequests[0]?.url;
				if (!pullRequest) throw new Error("Rebuild has no pull request");
				await call("report_rebuild", {
					summary: "Protocol fixture rebuilt the change",
					commits: [{ pullRequest, sha: "f".repeat(40), message: "Apply the document change" }],
					tasks: [],
				});
			} finally {
				await client.close();
			}
			return { stopReason: "end_turn" as const };
		}
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
