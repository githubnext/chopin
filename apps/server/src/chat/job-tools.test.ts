import { installJobCleanup } from "./job.test-fixtures";
import { expect, test } from "bun:test";
import * as Chat from "./service";
import { runJobTool } from "../agent/job-scope";
import { harness, JOB, until } from "./job.test-fixtures";

installJobCleanup();

test("resetting an interrupted session fails its active job without a transcript line", async () => {
	let state = harness();
	let running = Chat.job(state.context, JOB, "prompt", "session");
	await until(() => state.prompts.length === 1);
	await Chat.resetAgent(state.chat, "session", 1, "Planner credentials were revoked.");
	expect(await running).toEqual({
		status: "failed",
		reason: "Planner credentials were revoked.",
	});
	expect(state.chat.entries).toEqual([]);
});

test("two failed own-tool calls end the turn after one possible re-read", async () => {
	let state = harness();
	let running = Chat.job(state.context, JOB, "prompt", "session");
	await until(() => state.prompts.length === 1);
	for (let index = 0; index < 2; index++) {
		state.emit("tool.execution_start", {
			toolCallId: `tool-${index}`,
			toolName: "refine_decision",
		});
		state.emit("tool.execution_complete", {
			toolCallId: `tool-${index}`,
			success: true,
			result: { content: "Error: stale revision; read_plan again" },
		});
		if (index === 0) expect(state.chat.job).toBe(JOB);
	}
	let outcome = await running;
	expect(outcome.status).toBe("failed");
	if (outcome.status === "done") throw new Error("two tool failures completed the job");
	expect(outcome.reason).toContain("failed twice");
	expect(state.aborts()).toBe(1);
	expect(state.chat.job).toBeUndefined();
});

test("a bounded source-shape tool failure is reported without echoing its arguments", async () => {
	let state = harness();
	let running = Chat.job(state.context, JOB, "prompt", "session");
	await until(() => state.prompts.length === 1);
	state.emit("tool.execution_start", {
		toolCallId: "malformed-source",
		toolName: "refine_decision",
	});
	state.emit("tool.execution_complete", {
		toolCallId: "malformed-source",
		success: true,
		result: {
			content: "Error: source-shape",
			arguments: { source: { quote: "private malformed quote" } },
		},
	});
	state.emit("session.idle");

	let outcome = await running;
	expect(outcome).toEqual({ status: "failed", reason: "source-shape" });
	if (outcome.status === "done") throw new Error("a malformed source completed the job");
	expect(outcome.reason).not.toContain("private malformed quote");
	expect(outcome.reason).not.toContain("arguments");
});

test("a successful retry clears a prior source-shape tool failure", async () => {
	let state = harness();
	let running = Chat.job(state.context, JOB, "prompt", "session");
	await until(() => state.prompts.length === 1);
	state.emit("tool.execution_start", {
		toolCallId: "malformed-source",
		toolName: "refine_decision",
	});
	state.emit("tool.execution_complete", {
		toolCallId: "malformed-source",
		success: true,
		result: { content: "Error: source-shape" },
	});
	state.emit("tool.execution_start", {
		toolCallId: "valid-source",
		toolName: "refine_decision",
	});
	await runJobTool(state.chat, "refine_decision", async () => ({ output: { added: 1 } }));
	state.emit("tool.execution_complete", {
		toolCallId: "valid-source",
		success: true,
		result: { content: '{"ok":true}' },
	});
	state.emit("session.idle");

	expect(await running).toEqual({ status: "done", output: '{"added":1}' });
});
