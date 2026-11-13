import { installJobCleanup } from "./job.test-fixtures";
import { expect, spyOn, test } from "bun:test";
import * as Chat from "./service";
import { runJobTool } from "../agent/job-scope";
import { harness, JOB, member, socket, until } from "./job.test-fixtures";

installJobCleanup();

test.each([false, true])(
	"an owner-only follow-up never claims foreground credentials when queued=%s",
	async queued => {
		let state = harness();
		if (queued) {
			await Chat.send(state.context, socket(), member("Human first"));
			await until(() => state.prompts.length === 1);
		}
		state.context.auth.storage.channels.readAgent = async () => undefined;
		let claims = spyOn(state.context.auth.storage.channels, "claimAgentOwner");
		let followup = { ...JOB, id: "decision-followup:W1:m1", kind: "decision-followup" as const };
		let outcome: Awaited<ReturnType<typeof Chat.job>> | undefined;
		let pending = Chat.job(state.context, followup, "saved answer", undefined).then(value => {
			outcome = value;
		});
		if (queued) state.emit("session.idle");
		await until(() => !!outcome || state.prompts.length === 2);
		if (state.prompts.length === 2) state.emit("session.idle");
		await pending;
		expect(outcome).toMatchObject({ status: "deferred" });
		expect(claims).not.toHaveBeenCalled();
		expect(state.prompts).toHaveLength(queued ? 1 : 0);
	},
);

test("a job waits for a human turn, and a person's message while a job runs preempts it, without leaking job scope", async () => {
	let first = harness();
	await Chat.send(first.context, socket(), member("Human first"));
	await until(() => first.prompts.length === 1);
	let behind = Chat.job(first.context, JOB, "job second", "session");
	expect(first.chat.waiting).toHaveLength(1);
	first.emit("session.idle");
	await until(() => first.prompts.length === 2);
	expect(first.prompts[1]).toBe("job second");
	await runJobTool(first.chat, "refine_decision", async () => ({ output: { added: 0 } }));
	first.emit("session.idle");
	expect(await behind).toEqual({ status: "done", output: '{"added":0}' });

	let second = harness();
	let ahead = Chat.job(second.context, JOB, "job first", "session");
	await until(() => second.prompts.length === 1);
	// A job's session is isolated: nobody talks to it, and a person's message takes its place.
	let frames: Array<Record<string, unknown>> = [];
	let sender = {
		data: { handle: "ana", principalId: "U_ana" },
		send: (frame: string) => frames.push(JSON.parse(frame)),
	} as unknown as Parameters<typeof Chat.send>[1];
	await Chat.send(second.context, sender, member("Human second"));
	expect(frames).toEqual([expect.objectContaining({ kind: "chat:send" })]);
	expect(await ahead).toMatchObject({ status: "preempted" });
	await until(() => second.prompts.length === 2);
	// The person's turn has no job scope: the job's tool is refused to it.
	expect(second.chat.job).toBeUndefined();
	await expect(
		runJobTool(second.chat, "refine_decision", async () => ({ output: { added: 0 } })),
	).rejects.toThrow();
	expect(second.chat.waiting).toHaveLength(0);
	expect(second.steered).toEqual([]);
	second.emit("session.idle");
	await until(() => !second.chat.busy);
});

test("archiving cancels a job queued behind a human turn without dropping human work", async () => {
	let state = harness();
	await Chat.send(state.context, socket(), member("Human first"));
	await until(() => state.prompts.length === 1);
	let queued = Chat.job(state.context, JOB, "job later", "session");
	state.chat.waiting.push({ id: "human-later", handle: "ana", text: "Human later" });
	expect(state.chat.waiting).toHaveLength(2);
	Chat.cancelQueuedJobs(state.context, "This document was archived.");
	expect(await queued).toEqual({
		status: "failed",
		reason: "This document was archived.",
	});
	expect(state.chat.waiting.map(item => item.id)).toEqual(["human-later"]);
	state.emit("session.idle");
	await until(() => state.prompts.length === 2);
	expect(state.prompts).not.toContain("job later");
	state.emit("session.idle");
	await until(() => !state.chat.busy);
});

test("archive reset fences a job shifted out of the queue during persistence", async () => {
	let state = harness();
	await Chat.send(state.context, socket(), member("Human first"));
	await until(() => state.prompts.length === 1);
	let queued = Chat.job(state.context, JOB, "job later", "session");
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let saves = 0;
	state.context.persist = async () => {
		if (++saves === 2) {
			entered.resolve();
			await release.promise;
		}
	};
	state.emit("session.idle");
	await entered.promise;
	expect(state.chat.waiting).toEqual([]);
	Chat.cancelQueuedJobs(state.context, "This document was archived.");
	await Chat.resetAgent(state.chat, undefined, undefined, "This document was archived.");
	release.resolve();
	expect(await queued).toEqual({
		status: "failed",
		reason: "This document was archived.",
	});
	expect(state.prompts).toHaveLength(1);
});
