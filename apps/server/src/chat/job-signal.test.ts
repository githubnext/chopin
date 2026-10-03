import { installJobCleanup } from "./job.test-fixtures";
import { expect, test } from "bun:test";
import * as Chat from "./service";
import { harness, JOB, member, socket, until } from "./job.test-fixtures";

installJobCleanup();

test("the coordinator signal cancels only its queued job and retains human work", async () => {
	let h = harness();
	h.chat.busy = true;
	let signal = new AbortController();
	let queued = Chat.job(h.context, JOB, "prompt", "session", signal.signal);
	h.chat.waiting.push({ id: "human", handle: "ana", text: "Human later" });
	signal.abort();
	expect(await queued).toEqual({ status: "failed", reason: "The Planner job was cancelled." });
	expect(h.chat.waiting.map(item => item.id)).toEqual(["human"]);
	expect(h.prompts).toEqual([]);
});

test("the coordinator signal fences active own-tool scope before settling the turn", async () => {
	let h = harness();
	let signal = new AbortController();
	let running = Chat.job(h.context, JOB, "prompt", "session", signal.signal);
	await until(() => h.prompts.length === 1);
	signal.abort();
	expect(h.chat.job).toBeUndefined();
	expect(await running).toEqual({ status: "failed", reason: "The Planner job was cancelled." });
	expect(h.chat.entries).toEqual([]);
	expect(h.chat.busy).toBe(false);
});

test("the coordinator signal settles a shifted job before a held handoff commit finishes", async () => {
	let h = harness();
	await Chat.send(h.context, socket(), member("Human first"));
	await until(() => h.prompts.length === 1);
	let signal = new AbortController();
	let running = Chat.job(h.context, JOB, "later", "session", signal.signal);
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let saves = 0;
	h.context.persist = async () => {
		if (++saves === 2) {
			entered.resolve();
			await release.promise;
		}
	};
	h.emit("session.idle");
	await entered.promise;
	expect(h.chat.waiting).toEqual([]);
	signal.abort();
	expect(await running).toEqual({ status: "failed", reason: "The Planner job was cancelled." });
	release.resolve();
	await until(() => !h.chat.busy);
	expect(h.prompts).toHaveLength(1);
	expect(h.chat.handoffJob).toBeUndefined();
});
