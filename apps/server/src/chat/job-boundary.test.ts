import { installJobCleanup } from "./job.test-fixtures";
import { expect, test } from "bun:test";
import { runJobTool } from "../agent/job-scope";
import * as Chat from "./service";
import { harness, JOB, until } from "./job.test-fixtures";

installJobCleanup();

test("a job refuses an inactive write even after its own tool recorded output", async () => {
	let h = harness();
	let running = Chat.job(h.context, JOB, "prompt", "session");
	await until(() => h.prompts.length === 1);
	await runJobTool(h.chat, "refine_decision", async () => ({ output: {} }));
	h.emitPart({ type: "tool-call", toolCallId: "bad", toolName: "edit_plan", input: {} });
	expect(await running).toEqual({
		status: "failed",
		reason: "Planner tool boundary failure: edit_plan",
	});
	expect(h.chat.entries).toEqual([]);
});

test("a job does not trust a result without its live call identity", async () => {
	let h = harness();
	let running = Chat.job(h.context, JOB, "prompt", "session");
	await until(() => h.prompts.length === 1);
	h.emitPart({
		type: "tool-result",
		toolCallId: "unknown",
		toolName: "refine_decision",
		input: {},
		output: '{"added":1}',
	});
	expect(await running).toEqual({
		status: "failed",
		reason: "Planner tool boundary failure: unrecognized job tool result",
	});
	expect(h.chat.jobOutput).toBeUndefined();
});

test("a tool result cannot replace output produced by the captured own-tool wrapper", async () => {
	let h = harness();
	let running = Chat.job(h.context, JOB, "prompt", "session");
	await until(() => h.prompts.length === 1);
	h.emitPart({ type: "tool-call", toolCallId: "own", toolName: "refine_decision", input: {} });
	h.emitPart({
		type: "tool-result",
		toolCallId: "own",
		toolName: "refine_decision",
		input: {},
		output: '{"added":1}',
	});
	h.emit("session.idle");
	expect(await running).toEqual({
		status: "failed",
		reason: "The Planner ended without calling refine_decision.",
	});
});

test("a job aborts a permission refusal without publishing tool details", async () => {
	let h = harness();
	let running = Chat.job(h.context, JOB, "prompt", "session");
	await until(() => h.prompts.length === 1);
	h.emitPart({ type: "tool-call", toolCallId: "own", toolName: "refine_decision", input: {} });
	h.emitPart({ type: "tool-output-denied", toolCallId: "own", toolName: "refine_decision" });
	expect(await running).toEqual({
		status: "failed",
		reason: "Planner tool permission was denied.",
	});
	expect(h.chat.entries).toEqual([]);
	expect(h.frames.some(frame => frame.kind === "chat:tool")).toBe(false);
});
