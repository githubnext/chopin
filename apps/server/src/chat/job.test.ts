import { installJobCleanup } from "./job.test-fixtures";
import { expect, test } from "bun:test";
import * as Chat from "./service";
import { runJobTool } from "../agent/job-scope";
import { harness, JOB, until } from "./job.test-fixtures";

installJobCleanup();

test("job skips disabled and unavailable Planner sessions without transcript entries", async () => {
	let off = harness(false);
	expect(await Chat.job(off.context, JOB, "exact prompt", "session")).toEqual({
		status: "skipped",
		reason: "The Planner is off (AGENT=off).",
	});
	expect(off.chat.entries).toEqual([]);
	let missing = harness();
	missing.setOwnerAvailable(false);
	let outcome = await Chat.job(missing.context, JOB, "exact prompt", "session");
	expect(outcome.status).toBe("skipped");
	if (outcome.status === "done") throw new Error("an unavailable owner completed a job");
	expect(outcome.reason).toContain("owner is unavailable");
	expect(missing.chat.entries).toEqual([]);
	expect(missing.chat.busy).toBe(false);
	let credentials = harness();
	(credentials.context.auth.sessions as never as { resolve: () => Promise<never> }).resolve =
		async () => {
			throw new Error("credential expired");
		};
	expect(await Chat.job(credentials.context, JOB, "prompt", "session")).toEqual({
		status: "skipped",
		reason: "credential expired",
	});
});

test("job sends its prompt verbatim and keeps backscroll while suppressing model chatter", async () => {
	let state = harness();
	state.chat.backscroll = [{ handle: "ana", text: "Human context" }];
	let running = Chat.job(state.context, JOB, "EXACT job prompt\nsecond line", "session");
	await until(() => state.prompts.length === 1);
	expect(state.prompts).toEqual(["EXACT job prompt\nsecond line"]);
	expect(state.chat.turn?.handle).toBe("chopin");
	expect(state.chat.job).toBe(JOB);
	state.emit("assistant.message_delta", { messageId: "m", deltaContent: "private thought" });
	state.emit("assistant.message", { messageId: "m", content: "private thought" });
	state.emit("tool.execution_start", { toolCallId: "tool", toolName: "refine_decision" });
	await runJobTool(state.chat, "refine_decision", async () => ({ output: { added: 1 } }));
	state.emit("tool.execution_complete", {
		toolCallId: "tool",
		success: true,
		result: { content: '{"ok":true}' },
	});
	state.emit("session.idle");
	expect(await running).toEqual({ status: "done", output: '{"added":1}' });
	expect(state.chat.backscroll).toEqual([{ handle: "ana", text: "Human context" }]);
	expect(state.chat.entries).toEqual([]);
	expect(state.frames.some(frame => frame.kind === "chat:message" || frame.kind === "chat:tool"))
		.toBe(false);
	expect(state.chat.job).toBeUndefined();
	expect(state.chat.jobOutput).toBeUndefined();
	expect(state.chat.busy).toBe(false);
});

test("job fails on SDK send error, session error after tool output, and a tool-less idle", async () => {
	let send = harness();
	send.setSendError(new Error("send unavailable"));
	expect(await Chat.job(send.context, JOB, "prompt", "session")).toEqual({
		status: "failed",
		reason: "send unavailable",
	});
	expect(send.chat.entries).toEqual([]);

	let crashed = harness();
	let work = Chat.job(crashed.context, JOB, "prompt", "session");
	await until(() => crashed.prompts.length === 1);
	await runJobTool(crashed.chat, "refine_decision", async () => ({ output: { added: 1 } }));
	crashed.emit("session.error", { message: "model failed after the write" });
	expect(await work).toEqual({ status: "failed", reason: "model failed after the write" });
	expect(crashed.chat.entries).toEqual([]);

	let idle = harness();
	let empty = Chat.job(idle.context, JOB, "prompt", "session");
	await until(() => idle.prompts.length === 1);
	idle.emit("session.idle");
	expect(await empty).toEqual({
		status: "failed",
		reason: "The Planner ended without calling refine_decision.",
	});

	let long = harness();
	long.setSendError(new Error("x".repeat(600)));
	let bounded = await Chat.job(long.context, JOB, "prompt", "session");
	expect(bounded.status).toBe("failed");
	if (bounded.status === "done") throw new Error("a failed send completed the job");
	expect(bounded.reason).toHaveLength(500);
});
