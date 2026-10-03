import { installJobCleanup } from "./job.test-fixtures";
import { expect, test } from "bun:test";
import * as Chat from "./service";
import { runJobTool } from "../agent/job-scope";
import { harness, JOB, until } from "./job.test-fixtures";

installJobCleanup();

test("closing resolves queued and active jobs, and the queue has a bound", async () => {
	let queued = harness();
	queued.chat.busy = true;
	let waiting = Chat.job(queued.context, JOB, "prompt", "session");
	expect(queued.chat.waiting).toHaveLength(1);
	await Chat.close(queued.chat);
	expect(await waiting).toEqual({ status: "failed", reason: "The document closed." });
	expect(queued.chat.waiting).toEqual([]);

	let active = harness();
	let running = Chat.job(active.context, JOB, "prompt", "session");
	await until(() => active.prompts.length === 1);
	await Chat.close(active.chat);
	expect(await running).toEqual({ status: "failed", reason: "The document closed." });

	let full = harness();
	full.chat.busy = true;
	for (let index = 0; index < 20; index++) {
		full.chat.waiting.push({ id: `w${index}`, handle: "ana", text: "human" });
	}
	expect(await Chat.job(full.context, JOB, "prompt", "session")).toEqual({
		status: "skipped",
		reason: "The Planner queue is full.",
	});
	expect(full.chat.waiting).toHaveLength(20);
});

test("ephemeral state and queue broadcast failures cannot strand a job", async () => {
	let direct = harness();
	direct.breakFrame("chat:state");
	let running = Chat.job(direct.context, JOB, "prompt", "session");
	await until(() => direct.prompts.length === 1);
	await runJobTool(direct.chat, "refine_decision", async () => ({ output: {} }));
	direct.emit("session.idle");
	expect(await running).toEqual({ status: "done", output: "{}" });

	let queued = harness();
	queued.chat.busy = true;
	queued.breakFrame("chat:queue");
	let waiting = Chat.job(queued.context, JOB, "prompt", "session");
	expect(queued.chat.waiting).toHaveLength(1);
	await Chat.close(queued.chat);
	expect(await waiting).toEqual({ status: "failed", reason: "The document closed." });
});

test("a final persist failure settles the job and releases the queue", async () => {
	let state = harness();
	state.context.persist = async () => {
		throw new Error("storage unavailable");
	};
	let running = Chat.job(state.context, JOB, "prompt", "session");
	await until(() => state.prompts.length === 1);
	let queued = Chat.job(state.context, { ...JOB, id: "refine:W2:m2" }, "later", "session");
	await runJobTool(state.chat, "refine_decision", async () => ({ output: { added: 1 } }));
	state.emit("session.idle");
	let outcome = await Promise.race([
		running,
		Bun.sleep(300).then(() => {
			throw new Error("job promise stranded by persist failure");
		}),
	]);
	expect(outcome.status).toBe("failed");
	expect(await queued).toEqual({
		status: "failed",
		reason: "The Planner turn could not be saved.",
	});
	expect(state.chat.busy).toBe(false);
	expect(state.chat.waiting).toEqual([]);
});
