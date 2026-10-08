import { expect, test } from "bun:test";
import { runAgent } from "./acp";
import { createBridge } from "./bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { performance } from "@chopin/experiment/fixtures";

test.skipIf(!process.env.CHOPIN_TEST_ACP_COMMAND)(
	"real ACP implementation smoke check",
	async () => {
		let updates: unknown[] = [];
		let stop = await runAgent({
			command: JSON.parse(process.env.CHOPIN_TEST_ACP_COMMAND!),
			cwd: process.cwd(),
			prompt: "Respond with ACP smoke check passed. Do not use tools or edit any files.",
			mcpServers: [],
			signal: AbortSignal.timeout(60_000),
			onUpdate: value => updates.push(value),
			permission: async () => undefined,
		});
		expect(stop).toBe("end_turn");
		expect(updates.length).toBeGreaterThan(0);
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

test("run-scoped MCP tools accept typed evidence and expose no arbitrary host operations", async () => {
	let received: unknown;
	let server = createBridge({
		id: crypto.randomUUID(),
		documentId: crypto.randomUUID(),
		brief: "Measure startup",
		source: { repositoryId: "repo", repository: "org/repo", commit: "a".repeat(40) },
		context: "",
		requester: "alice",
		authorizer: "alice",
	}, async result => {
		received = result;
	});
	let client = new Client({ name: "test", version: "1" });
	let [left, right] = InMemoryTransport.createLinkedPair();
	await server.connect(right);
	await client.connect(left);
	try {
		expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
			"read_investigation",
			"submit_investigation_result",
		]);
		let result = await client.callTool({
			name: "submit_investigation_result",
			arguments: { result: performance },
		});
		expect(result.isError).not.toBe(true);
		expect(received).toEqual(performance);
	} finally {
		await client.close();
		await server.close();
	}
});
