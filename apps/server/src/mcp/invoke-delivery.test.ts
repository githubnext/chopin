/**
 * A keyed `invoke_planner` call records its start, and answers success, only once the instruction
 * reached a turn: its own turn started, or the person's turn running took it. A hand-off that a
 * turn ending, a Stop or a stopping process leaves unread is refused, and a retry delivers it.
 */
import { expect, test } from "bun:test";

import * as Chat from "../chat/service";
import { harness, installJobCleanup, JOB, member, socket, until } from "../chat/job.test-fixtures";
import { MemoryMcpInvocationStore } from "../storage/memory/mcp-invocations";
import { IdempotentInvocations, invocationFingerprint } from "./invoke";

import type { Lease } from "../storage/model";

installJobCleanup();

const BO = { id: "U_bo", login: "bo" };
const RESULT = { document: { id: "room", title: "Room", url: "https://chopin.test/room" } };
const UNAVAILABLE = { kind: "refused", code: "planner-unavailable" } as const;

/** `invoke_planner` under one idempotency key, delivered to the harness's Chat as `invokeRouted` does. */
function keyed(h: ReturnType<typeof harness>, instruction: string) {
	let store = new MemoryMcpInvocationStore({ channelExists: () => true, assertLease() {} });
	let scope = { userId: BO.id, channelId: "room", key: "hand-off" };
	let process = () => new IdempotentInvocations(store, () => ({}) as Lease, () => new Date());
	let invocations = process();
	return {
		invoke: () =>
			invocations.run(scope, invocationFingerprint({ instruction }, "room"), RESULT, async key => {
				let delivery = await key.reconcile(id => h.chat.entries.some(entry => entry.id === id));
				if (delivery === "idempotency-conflict") return { kind: "refused", code: delivery };
				let code = await Chat.invoke(
					h.context,
					BO,
					instruction,
					undefined,
					undefined,
					undefined,
					undefined,
					delivery,
				);
				return code ? { kind: "refused", code } : { kind: "invoked", ...RESULT };
			}),
		/** A new process over the same storage and Chat, holding none of the calls' memory. */
		restart: () => {
			invocations = process();
		},
		record: () => store.get(scope),
		posted: () => h.chat.entries.filter(entry => entry.text === instruction),
	};
}

test("an instruction waiting behind a job that a stopping process drops is refused, and a retry starts its turn", async () => {
	let h = harness();
	let instruction = "Do not lose this instruction.";
	let call = keyed(h, instruction);
	let job = Chat.job(h.context, JOB, "background job", "session");
	await until(() => h.prompts.length === 1);
	// The job's own write is under way, so it gives way only once that is done.
	let write = Promise.withResolvers<void>();
	h.chat.jobWriting = write.promise;
	let first = call.invoke();
	await until(() => !!h.chat.preempting);
	Chat.holdStarts();
	try {
		write.resolve();
		await job;
		await until(() => !h.chat.busy);
		await h.chat.running;
		expect(await first).toEqual(UNAVAILABLE);
	} finally {
		Chat.holdStarts(false);
	}
	expect((await call.record())?.invokedAt).toBeUndefined();
	expect(h.prompts).toHaveLength(1);

	call.restart();
	expect(await call.invoke()).toMatchObject({ kind: "invoked" });
	await until(() => h.prompts.length === 2);
	expect(h.prompts[1]).toContain(instruction);
	expect(call.posted()).toHaveLength(1);
	expect((await call.record())?.invokedAt).toBeInstanceOf(Date);
});

test("an instruction whose running turn ends while it is saved, with a job taking the Chat, is refused, and a retry reaches a turn", async () => {
	let h = harness();
	let instruction = "Read my instruction.";
	let call = keyed(h, instruction);
	await Chat.send(h.context, socket(), member("@chopin first turn"));
	await until(() => h.prompts.length === 1);
	let job = Chat.job(h.context, JOB, "background job", "session");
	let saving = Promise.withResolvers<void>();
	let resume = Promise.withResolvers<void>();
	let persist = h.context.persist;
	h.context.persist = async chat => {
		h.context.persist = persist;
		saving.resolve();
		await resume.promise;
		return persist(chat);
	};
	let first = call.invoke();
	await saving.promise;
	h.emit("session.idle");
	await until(() => h.prompts.length === 2);
	expect(h.chat.backgroundTurn).toBeDefined();
	resume.resolve();
	expect(await first).toEqual(UNAVAILABLE);
	expect((await call.record())?.invokedAt).toBeUndefined();
	expect(h.steered).toEqual([]);

	// The job gives way to the retry, whose turn starts as the job's ends.
	expect(await call.invoke()).toMatchObject({ kind: "invoked" });
	expect(await job).toMatchObject({ status: "preempted" });
	await until(() => h.prompts.length === 3);
	expect(h.prompts[2]).toContain(instruction);
	expect(call.posted()).toHaveLength(1);
	expect((await call.record())?.invokedAt).toBeInstanceOf(Date);
});

test("an instruction is not given to a turn being stopped, and a retry starts its own once that turn ends", async () => {
	let h = harness();
	let instruction = "Read me before you stop.";
	let call = keyed(h, instruction);
	// A turn that ends only when let go, as one stopped on a remote machine can take a while to.
	let prompts: string[] = [];
	let steered: string[] = [];
	let gates: Array<PromiseWithResolvers<void>> = [];
	let session = {
		activeTools: ["read_plan"],
		async stream(prompt: string) {
			prompts.push(prompt);
			let gate = Promise.withResolvers<void>();
			gates.push(gate);
			return {
				fullStream: (async function*() {
					yield* await gate.promise.then(() => []);
				})(),
			};
		},
		async steer(text: string) {
			steered.push(text);
		},
		async destroy() {
			for (let gate of gates) gate.resolve();
		},
	};
	h.context.openPlannerSession = async () => ({ ok: true, value: session }) as never;
	await Chat.send(h.context, socket(), member("@chopin first turn"));
	await until(() => prompts.length === 1);
	let saving = Promise.withResolvers<void>();
	let resume = Promise.withResolvers<void>();
	let persist = h.context.persist;
	h.context.persist = async chat => {
		h.context.persist = persist;
		saving.resolve();
		await resume.promise;
		return persist(chat);
	};
	let first = call.invoke();
	await saving.promise;
	h.chat.turnController!.abort();
	resume.resolve();
	expect(await first).toEqual(UNAVAILABLE);
	expect(steered).toEqual([]);
	expect((await call.record())?.invokedAt).toBeUndefined();

	gates[0]!.resolve();
	await until(() => !h.chat.busy);
	expect(await call.invoke()).toMatchObject({ kind: "invoked" });
	await until(() => prompts.length === 2);
	expect(prompts[1]).toContain(instruction);
	expect(call.posted()).toHaveLength(1);
	expect((await call.record())?.invokedAt).toBeInstanceOf(Date);
	for (let gate of gates) gate.resolve();
	await h.chat.running;
});

test("an instruction given to the person's turn running is recorded once that turn takes it", async () => {
	let h = harness();
	let instruction = "Also check the appendix.";
	let call = keyed(h, instruction);
	await Chat.send(h.context, socket(), member("@chopin first turn"));
	await until(() => h.prompts.length === 1);
	expect(await call.invoke()).toMatchObject({ kind: "invoked" });
	expect(h.steered).toHaveLength(1);
	expect(h.steered[0]).toContain(instruction);
	expect((await call.record())?.invokedAt).toBeInstanceOf(Date);
	expect(await call.invoke()).toMatchObject({ kind: "invoked" });
	expect(h.steered).toHaveLength(1);
	expect(h.prompts).toHaveLength(1);
});
