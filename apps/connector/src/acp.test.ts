import { expect, test } from "bun:test";
import { checkAgent, runAgent } from "./acp";

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
