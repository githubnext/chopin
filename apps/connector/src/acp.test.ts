import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { checkAgent, runAgent } from "./acp";
import { serveLocalBridge } from "./local-bridge";

test.skipIf(!process.env.CHOPIN_TEST_ACP_COMMAND)(
	"a real ACP agent calls the supplied authenticated implementation tool",
	async () => {
		let cwd = await mkdtemp(join(tmpdir(), "chopin-acp-contract-"));
		let calls: string[] = [];
		let bridge = serveLocalBridge(async () => {
			let server = new Server({ name: "build-contract", version: "1" }, {
				capabilities: { tools: {} },
			});
			server.setRequestHandler(ListToolsRequestSchema, () => ({
				tools: [{
					name: "read_implementation",
					description: "Read the authorized implementation plan.",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				}],
			}));
			server.setRequestHandler(CallToolRequestSchema, request => {
				calls.push(request.params.name);
				return { content: [{ type: "text", text: "ACP build bridge passed. Stop now." }] };
			});
			return server;
		});
		try {
			let stop = await runAgent({
				command: JSON.parse(process.env.CHOPIN_TEST_ACP_COMMAND!),
				cwd,
				prompt: "Call read_implementation from the supplied MCP server once, then stop. "
					+ "Do not use other tools or edit files.",
				mcpServers(http) {
					return [{
						name: `chopin-contract-${crypto.randomUUID()}`,
						...(http
							? {
								type: "http" as const,
								url: bridge.url,
								headers: [{ name: "Authorization", value: `Bearer ${bridge.token}` }],
							}
							: {
								command: process.execPath,
								args: [fileURLToPath(new URL("./testing/mcp-proxy.ts", import.meta.url))],
								env: [
									{ name: "CHOPIN_SMOKE_URL", value: bridge.url },
									{ name: "CHOPIN_SMOKE_TOKEN", value: bridge.token },
								],
							}),
					}];
				},
				signal: AbortSignal.timeout(60_000),
				onUpdate: () => {},
				permission: async request =>
					request.options.find(option => option.kind === "allow_once")?.optionId,
			});
			expect(stop).toBe("end_turn");
			expect(calls).toEqual(["read_implementation"]);
		} finally {
			await bridge.close();
			await rm(cwd, { recursive: true, force: true });
		}
	},
	70_000,
);

test("a generic ACP process receives a cwd and produces protocol updates", async () => {
	let updates: unknown[] = [];
	let stop = await runAgent({
		command: [process.execPath, new URL("./testing/fake-agent.ts", import.meta.url).pathname],
		cwd: process.cwd(),
		prompt: "Investigate",
		mcpServers: [],
		signal: new AbortController().signal,
		onUpdate: value => updates.push(value),
		permission: async () => undefined,
	});
	expect(stop).toBe("end_turn");
	expect(updates).toHaveLength(1);
});

test("the agent's name and version come from its ACP initialize answer, at a check or a run", async () => {
	let command = [process.execPath, new URL("./testing/fake-agent.ts", import.meta.url).pathname];
	let checked: unknown[] = [];
	expect(
		await checkAgent(command, {
			cwd: process.cwd(),
			env: process.env,
			onInfo: info => checked.push(info),
		}),
	).toBeUndefined();
	let ran: unknown[] = [];
	await runAgent({
		command,
		cwd: process.cwd(),
		prompt: "Investigate",
		mcpServers: [],
		signal: new AbortController().signal,
		onUpdate: () => {},
		permission: async () => undefined,
		onInfo: info => ran.push(info),
	});
	// The title, as people know it, rather than the package name.
	expect(checked).toEqual([{ name: "Fake Agent", version: "1.2.3" }]);
	expect(ran).toEqual(checked);
});

test("ACP cancellation finishes the active turn through the standard protocol", async () => {
	let abort = new AbortController();
	let stop = await runAgent({
		command: [
			process.execPath,
			new URL("./testing/fake-agent.ts", import.meta.url).pathname,
			"--hold",
		],
		cwd: process.cwd(),
		prompt: "Wait",
		mcpServers: [],
		signal: abort.signal,
		onUpdate: () => abort.abort(),
		permission: async () => undefined,
	});
	expect(stop).toBe("cancelled");
});

test.skipIf(process.platform === "win32")(
	"an agent that exits before its session reports how, and one that starts says so",
	async () => {
		let starts: unknown[] = [];
		let options = {
			cwd: process.cwd(),
			prompt: "Investigate",
			mcpServers: [],
			signal: new AbortController().signal,
			onUpdate: () => {},
			permission: async () => undefined,
			onStart: (failure?: unknown) => void starts.push(failure),
		};
		let failed = await runAgent({
			...options,
			command: ["/bin/sh", "-c", "echo 'agent: no credentials' >&2; exit 127"],
		}).catch(error => error);
		expect(failed).toBeInstanceOf(Error);
		expect(starts).toEqual([{ how: "exit 127", stderr: "agent: no credentials" }]);
		await runAgent({
			...options,
			command: [process.execPath, new URL("./testing/fake-agent.ts", import.meta.url).pathname],
		});
		expect(starts).toEqual([{ how: "exit 127", stderr: "agent: no credentials" }, undefined]);
	},
);
