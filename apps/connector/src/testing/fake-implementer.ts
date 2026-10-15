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
		async () => {
			if (process.argv.includes("--slow-start")) {
				// An agent still starting, as one fetching itself on first launch is; it never answers.
				await writeFile(process.env.CHOPIN_TEST_STARTING!, "");
				await new Promise(() => {});
			}
			return {
				protocolVersion: PROTOCOL_VERSION,
				agentCapabilities: process.argv.includes("--http")
					? { mcpCapabilities: { http: true } }
					: {},
			};
		},
	)
	.onRequest("session/new", ({ params }) => {
		servers = params.mcpServers;
		cwd = params.cwd;
		return { sessionId: "implementation-acp-session" };
	})
	.onNotification("session/cancel", () => cancelled())
	.onRequest("session/prompt", async ({ params, client: ownerClient }) => {
		if (process.env.CHOPIN_TEST_SEEN) {
			let prompt = params.prompt.map(part => part.type === "text" ? part.text : "").join("\n");
			await writeFile(
				process.env.CHOPIN_TEST_SEEN,
				JSON.stringify({ prompt, worktrees: process.env.CHOPIN_RUN_WORKTREES ?? null }),
			);
		}
		if (process.argv.includes("--github")) {
			// What a build's agent pushes and opens pull requests with: gh's token, and Git's
			// credentials for github.com, asked as `git push` would.
			let fill = spawnSync("git", ["-C", cwd, "credential", "fill"], {
				input: "protocol=https\nhost=github.com\n\n",
				encoding: "utf8",
			});
			let gh = spawnSync("gh", ["pr", "create", "--draft", "--title", "Task one"], {
				cwd,
				encoding: "utf8",
			});
			await writeFile(
				process.env.CHOPIN_TEST_GITHUB!,
				JSON.stringify({
					GH_TOKEN: process.env.GH_TOKEN ?? null,
					GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
					credential: fill.status === 0 ? fill.stdout : null,
					gh: gh.status,
				}),
			);
			return { stopReason: "end_turn" as const };
		}
		if (process.argv.includes("--worktrees")) {
			// Two pull requests at once in extra worktrees where the prompt says, one left with
			// uncommitted changes and a dev server running in it.
			let folder = process.env.CHOPIN_RUN_WORKTREES!;
			for (let name of ["task-a", "task-b"]) {
				let added = spawnSync("git", [
					"-C",
					cwd,
					"worktree",
					"add",
					"-b",
					`chopin/${name}`,
					`${folder}/${name}`,
				], { encoding: "utf8" });
				if (added.status !== 0) throw new Error(added.stderr);
			}
			await writeFile(`${folder}/task-b/source.txt`, "changed, never committed");
			await writeFile(`${folder}/task-b/new.txt`, "untracked");
			let server = spawn("sleep", ["600"], {
				cwd: `${folder}/task-b`,
				detached: true,
				stdio: "ignore",
			});
			server.unref();
			await writeFile(process.env.CHOPIN_TEST_ORPHAN_PID!, String(server.pid));
			return { stopReason: "end_turn" as const };
		}
		if (process.argv.includes("--orphan")) {
			// A dev server in its own process group, as `vite &` from an agent's shell tool is.
			let server = spawn("sleep", ["600"], { cwd, detached: true, stdio: "ignore" });
			server.unref();
			await writeFile(process.env.CHOPIN_TEST_ORPHAN_PID!, String(server.pid));
			return { stopReason: "end_turn" as const };
		}
		// The agent's own turn interrupted, as when Ctrl-C reaches it with the connector.
		if (process.argv.includes("--self-cancel")) return { stopReason: "cancelled" as const };
		if (process.argv.includes("--hang")) {
			if (process.argv.includes("--activity")) {
				await ownerClient.notify("session/update", {
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tests",
						title: "Running server tests",
						kind: "execute",
						status: "in_progress",
					},
				});
				if (process.argv.includes("--permission-activity")) {
					let answer = await ownerClient.request("session/request_permission", {
						sessionId: params.sessionId,
						toolCall: { toolCallId: "tests", title: "Running server tests", kind: "execute" },
						options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
					});
					if (answer.outcome.outcome !== "selected") throw new Error("Permission was refused");
					await ownerClient.notify("session/update", {
						sessionId: params.sessionId,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "tests",
							title: "Checking test results",
							status: "in_progress",
						},
					});
				}
			}
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
