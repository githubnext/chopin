import { expect, test } from "bun:test";
import { createOutput } from "./output";
import { ask, describePermission, permissionMemory } from "./permission";
import { PassThrough } from "node:stream";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

function capture(tty: boolean, env: Record<string, string | undefined> = {}) {
	let out = "";
	let err = "";
	let output = createOutput(
		{ isTTY: tty, write: text => out += text },
		{ isTTY: tty, write: text => err += text },
		env,
	);
	return { output, out: () => out, err: () => err };
}

test("connector messages are plain text on stdout when not a terminal", () => {
	let { output, out, err } = capture(false);
	output.pairing("org/repo", "https://chopin.test/connect?pairing=abc", "ABCD-EFGH");
	output.connected(["org/repo"]);
	output.job("build", "Ship the thing", "/tmp/runs/1");
	output.finished();
	expect(out()).toBe(
		[
			"",
			"Chopin connector for org/repo",
			"",
			"1. Open this link and sign in:",
			"   https://chopin.test/connect?pairing=abc",
			"",
			"2. Check the page shows:",
			"   ABCD-EFGH",
			"",
			"✓ Connected.",
			"  Work you start in documents of any repository you can push to runs here. Ctrl-C "
			+ "disconnects.",
			"  It uses your checkouts of org/repo and clones any other.",
			"",
			"› Building Ship the thing",
			"  /tmp/runs/1",
			"  ✓ Finished",
			"",
		].join("\n") + "\n",
	);
	expect(err()).toBe("");
});

test("a terminal gets ANSI styling unless NO_COLOR is set", () => {
	let styled = capture(true);
	styled.output.pairing("org/repo", "https://chopin.test/x", "ABCD-EFGH");
	expect(styled.out()).toContain("\x1b[1mChopin connector for org/repo\x1b[22m");
	expect(styled.out()).toContain("\x1b[4m\x1b[36mhttps://chopin.test/x\x1b[39m\x1b[24m");
	let plain = capture(true, { NO_COLOR: "1" });
	plain.output.pairing("org/repo", "https://chopin.test/x", "ABCD-EFGH");
	expect(plain.out()).not.toContain("\x1b[");
});

test("failures go to stderr in red; agent noise only with CHOPIN_DEBUG=1", () => {
	let quiet = capture(true);
	quiet.output.agent("loading model\n");
	quiet.output.failed("Agent stopped: refusal", ["auth required"]);
	expect(quiet.out()).toBe("");
	expect(quiet.err()).toContain("\x1b[31m✗ Failed: Agent stopped: refusal\x1b[39m");
	expect(quiet.err()).toContain("agent │ auth required");
	expect(quiet.err()).not.toContain("loading model");
	let debug = capture(false, { CHOPIN_DEBUG: "1" });
	debug.output.agent("loading model\n");
	expect(debug.err()).toBe("  agent │ loading model\n");
});

test("job lines name the work by kind and a long brief by its first line", () => {
	let { output, out } = capture(false);
	output.job("investigation", "Measure startup\nwith details", "/w");
	output.job("spike", "x".repeat(100), "/w");
	expect(out()).toContain("› Investigating Measure startup\n");
	expect(out()).toContain(`› Prototyping ${"x".repeat(79)}…\n`);
});

function request(
	toolCall: Partial<RequestPermissionRequest["toolCall"]>,
): RequestPermissionRequest {
	return {
		sessionId: "s",
		toolCall: { toolCallId: "t", ...toolCall },
		options: [
			{ optionId: "once", name: "Allow once", kind: "allow_once" },
			{ optionId: "always", name: "Always allow", kind: "allow_always" },
			{ optionId: "deny", name: "Deny", kind: "reject_once" },
		],
	};
}

test("a permission request shows the tool kind and the actual command, paths or input", () => {
	expect(describePermission(request({
		kind: "execute",
		title: "Running command",
		rawInput: { command: "bun test\nbun run types" },
	}))).toEqual(["execute: Running command", "$ bun test", "  bun run types"]);
	expect(describePermission(request({
		kind: "edit",
		title: "Edit file",
		locations: [{ path: "/w/a.ts", line: 3 }, { path: "/w/b.ts" }],
	}))).toEqual(["edit: Edit file", "/w/a.ts:3", "/w/b.ts"]);
	expect(describePermission(request({ title: "Fetch", rawInput: { url: "https://x.test" } })))
		.toEqual(["tool: Fetch", '{"url":"https://x.test"}']);
});

test("always allow is remembered for that tool kind only", () => {
	let memory = permissionMemory();
	let run = request({ kind: "execute", title: "Running command" });
	expect(memory.remembered(run)).toBeUndefined();
	memory.chose(run, "once");
	expect(memory.remembered(run)).toBeUndefined();
	memory.chose(run, "always");
	expect(memory.remembered(request({ kind: "execute", title: "Another command" }))).toBe("always");
	expect(memory.remembered(request({ kind: "edit", title: "Edit file" }))).toBeUndefined();
});

test("Ctrl-C at a permission prompt interrupts the connector instead of pausing readline", async () => {
	let input = new PassThrough();
	let controller = new AbortController();
	let interrupted = 0;
	let answer = ask("Select option: ", {
		input,
		output: new PassThrough(),
		terminal: true,
		signal: controller.signal,
		interrupt: () => {
			interrupted++;
			controller.abort();
		},
	});
	input.write("\x03");
	expect(await answer).toBeUndefined();
	expect(interrupted).toBe(1);
});

test("a permission prompt returns the typed answer", async () => {
	let input = new PassThrough();
	let answer = ask("Select option: ", {
		input,
		output: new PassThrough(),
		signal: new AbortController().signal,
		interrupt: () => {},
	});
	input.write("2\n");
	expect(await answer).toBe("2");
});
