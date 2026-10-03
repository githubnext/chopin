import { installJobCleanup } from "./job.test-fixtures";
import { expect, test } from "bun:test";
import * as Chat from "./service";
import { runJobTool } from "../agent/job-scope";
import { harness, JOB, member, socket, until } from "./job.test-fixtures";

installJobCleanup();

test("jobs and human turns drain in arrival order without leaking job scope", async () => {
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
	await Chat.send(second.context, socket(), member("Human second"));
	expect(second.chat.waiting).toHaveLength(1);
	await runJobTool(second.chat, "refine_decision", async () => ({ output: { added: 0 } }));
	second.emit("session.idle");
	expect(await ahead).toEqual({ status: "done", output: '{"added":0}' });
	await until(() => second.prompts.length === 2);
	expect(second.chat.job).toBeUndefined();
	expect(second.prompts[1]).toContain("Human second");
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
	expect(state.frames.at(-1)).toMatchObject({ kind: "chat:queue" });
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
