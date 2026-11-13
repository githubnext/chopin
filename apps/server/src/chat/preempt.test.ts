/**
 * A person's message to the Planner is never refused because a background job is running: it
 * preempts the job's turn, which goes back to wait and runs again once the person's turn is over.
 */
import { expect, test } from "bun:test";

import * as Chat from "./service";
import { runJobTool } from "../agent/job-scope";
import { harness, installJobCleanup, JOB, member, until } from "./job.test-fixtures";

import type { Socket } from "../wire";

installJobCleanup();

type Frame = { kind: string; [key: string]: unknown };

function speaking(handle: string, frames: Frame[] = []): Socket {
	return {
		data: { handle, principalId: `U_${handle}` },
		send: (raw: string) => frames.push(JSON.parse(raw) as Frame),
	} as unknown as Socket;
}

test("a message to the Planner while a background job runs starts the person's turn at once, and the job waits to run again", async () => {
	let h = harness();
	let job = Chat.job(h.context, JOB, "job prompt", "session");
	await until(() => h.prompts.length === 1);
	// A job's turn is quiet: Chat draws no turn for it and offers no Stop.
	expect(h.chat.turn?.quiet).toBe(true);

	let frames: Frame[] = [];
	let ask = member("@chopin what is the plan?");
	await Chat.send(h.context, speaking("bo", frames), ask);

	// Accepted, never refused, and the job's turn gives way to the person's.
	expect(frames).toEqual([expect.objectContaining({ kind: "chat:send", id: ask.requestId })]);
	expect(await job).toEqual({ status: "preempted", reason: "A person asked the Planner." });
	await until(() => h.prompts.length === 2);
	expect(h.prompts[1]).toContain("what is the plan?");
	expect(h.chat.job).toBeUndefined();
	expect(h.chat.turn?.handle).toBe("bo");
	// The person's turn is one people watch, and can talk to.
	expect(h.chat.turn?.quiet).toBeUndefined();
	expect(h.chat.steering).toBeDefined();
	let shown = h.frames.filter(frame => frame.kind === "chat:state").at(-1);
	expect(shown).toMatchObject({ busy: true, turn: { handle: "bo" } });
	expect(shown?.turn).not.toHaveProperty("quiet");
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("a job whose own tool already wrote when a person asks is done, not run again", async () => {
	let h = harness();
	let job = Chat.job(h.context, JOB, "job prompt", "session");
	await until(() => h.prompts.length === 1);
	await runJobTool(h.chat, "refine_decision", async () => ({ output: { added: 1 } }));

	await Chat.send(h.context, speaking("bo"), member("@chopin now?"));
	expect(await job).toEqual({ status: "done", output: '{"added":1}' });
	await until(() => h.prompts.length === 2);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("a write the job's tool has under way finishes whole and is its result; no write starts after", async () => {
	let h = harness();
	let job = Chat.job(h.context, JOB, "job prompt", "session");
	await until(() => h.prompts.length === 1);
	let write = Promise.withResolvers<void>();
	let writing = runJobTool(h.chat, "refine_decision", async () => {
		await write.promise;
		return { output: { added: 2 } };
	});

	await Chat.send(h.context, speaking("bo"), member("@chopin now?"));
	// The job's turn is still there, waiting for its write: nothing else may write meanwhile.
	await Bun.sleep(5);
	expect(h.prompts).toHaveLength(1);
	expect(h.aborts()).toBe(0);
	await expect(
		runJobTool(h.chat, "refine_decision", async () => ({ output: { added: 3 } })),
	).rejects.toThrow("a person's turn took the Planner");

	write.resolve();
	expect(await writing).toMatchObject({ ok: true, added: 2 });
	expect(await job).toEqual({ status: "done", output: '{"added":2}' });
	await until(() => h.prompts.length === 2);
	expect(h.prompts[1]).toContain("now?");
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("a job that keeps meeting messages gives way three times, then finishes with the person's turn right behind it", async () => {
	let h = harness();
	for (let round = 1; round <= 3; round++) {
		let job = Chat.job(h.context, JOB, "job prompt", "session");
		await until(() => h.prompts.length === 2 * round - 1);
		await Chat.send(h.context, speaking("bo"), member(`@chopin question ${round}`));
		expect(await job).toMatchObject({ status: "preempted" });
		await until(() => h.prompts.length === 2 * round);
		h.emit("session.idle");
		await until(() => !h.chat.busy);
	}

	let job = Chat.job(h.context, JOB, "job prompt", "session");
	await until(() => h.prompts.length === 7);
	// Run again after giving way, the job's turn is as quiet as ever.
	expect(h.chat.turn?.quiet).toBe(true);
	let frames: Frame[] = [];
	let ask = member("@chopin question 4");
	await Chat.send(h.context, speaking("bo", frames), ask);
	// Still accepted at once; the job is let finish this time.
	expect(frames).toEqual([expect.objectContaining({ kind: "chat:send", id: ask.requestId })]);
	await Bun.sleep(5);
	expect(h.prompts).toHaveLength(7);
	expect(h.chat.job).toBe(JOB);
	await runJobTool(h.chat, "refine_decision", async () => ({ output: { added: 0 } }));
	h.emit("session.idle");
	expect(await job).toEqual({ status: "done", output: '{"added":0}' });
	await until(() => h.prompts.length === 8);
	expect(h.prompts[7]).toContain("question 4");
	h.emit("session.idle");
	await until(() => !h.chat.busy);

	// Finished, it starts over: the next run gives way again.
	let next = Chat.job(h.context, JOB, "job prompt", "session");
	await until(() => h.prompts.length === 9);
	await Chat.send(h.context, speaking("bo"), member("@chopin question 5"));
	expect(await next).toMatchObject({ status: "preempted" });
	await until(() => h.prompts.length === 10);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("a job being handed the Chat when a person asks waits behind their turn, then runs", async () => {
	let h = harness();
	await Chat.send(h.context, speaking("ana"), member("@chopin first"));
	await until(() => h.prompts.length === 1);
	let job = Chat.job(h.context, JOB, "job prompt", "session");
	expect(h.chat.waiting).toHaveLength(1);

	// The save that hands the job the Chat is slow.
	let persist = h.context.persist;
	let handoff = Promise.withResolvers<void>();
	let armed = true;
	h.context.persist = async chat => {
		if (armed && h.chat.starting) {
			armed = false;
			await handoff.promise;
		}
		await persist(chat);
	};
	h.emit("session.idle");
	await until(() => !!h.chat.handoffJob);

	let frames: Frame[] = [];
	let ask = member("@chopin second");
	await Chat.send(h.context, speaking("bo", frames), ask);
	expect(frames).toEqual([expect.objectContaining({ kind: "chat:send", id: ask.requestId })]);
	handoff.resolve();
	await until(() => h.prompts.length === 2);
	expect(h.prompts[1]).toContain("second");
	expect(h.chat.waiting.map(item => item.job?.job)).toEqual([JOB]);

	h.emit("session.idle");
	await until(() => h.prompts.length === 3);
	expect(h.prompts[2]).toBe("job prompt");
	await runJobTool(h.chat, "refine_decision", async () => ({ output: { added: 0 } }));
	h.emit("session.idle");
	expect(await job).toEqual({ status: "done", output: '{"added":0}' });
	await until(() => !h.chat.busy);
});

test("a harness that takes no message mid-run still starts the person's turn in place of a job", async () => {
	let h = harness();
	h.context.steers = undefined;
	h.context.config.harness = "copilot-sdk";
	let job = Chat.job(h.context, JOB, "job prompt", "session");
	await until(() => h.prompts.length === 1);
	let frames: Frame[] = [];
	let ask = member("@chopin now?");
	await Chat.send(h.context, speaking("bo", frames), ask);
	expect(frames).toEqual([expect.objectContaining({ kind: "chat:send", id: ask.requestId })]);
	expect(await job).toMatchObject({ status: "preempted" });
	await until(() => h.prompts.length === 2);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("an MCP caller's instruction preempts a background job too, and is settled when its turn ends", async () => {
	let h = harness();
	let job = Chat.job(h.context, JOB, "job prompt", "session");
	await until(() => h.prompts.length === 1);
	let settled = false;
	expect(
		await Chat.invoke(
			h.context,
			{ id: "U_bo", login: "bo" },
			"Plan this.",
			undefined,
			undefined,
			() => {
				settled = true;
			},
		),
	).toBeUndefined();
	expect(await job).toMatchObject({ status: "preempted" });
	await until(() => h.prompts.length === 2);
	expect(h.prompts[1]).toContain("Plan this.");
	expect(settled).toBe(false);
	h.emit("session.idle");
	await until(() => settled);
});
