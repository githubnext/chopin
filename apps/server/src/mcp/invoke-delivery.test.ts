/**
 * A keyed `invoke_planner` call records its start, and answers success, only once the instruction
 * reached a turn: its own turn started, or the person's turn running took it. A hand-off that a
 * turn ending, a Stop or a stopping process leaves unread is refused, and a retry delivers it.
 */
import { describe, expect, test } from "bun:test";

import * as Chat from "../chat/service";
import { harness, installJobCleanup, JOB, member, socket, until } from "../chat/job.test-fixtures";
import { MemoryMcpInvocationStore } from "../storage/memory/mcp-invocations";
import { IdempotentInvocations, invocationFingerprint, UNCONFIRMED } from "./invoke";

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

/**
 * Asserts the call waits on a hand-off the Chat holds, then that `shutdown` tells it its instruction
 * reached no turn, leaving nothing in the Chat still waiting.
 */
async function toldOnShutdown(
	h: ReturnType<typeof harness>,
	first: Promise<unknown>,
	shutdown: () => Promise<void>,
	answer: unknown = UNAVAILABLE,
): Promise<void> {
	expect(await Promise.race([first, Bun.sleep(20).then(() => "waiting")])).toBe("waiting");
	expect(h.chat.deliveries?.size).toBe(1);
	await shutdown();
	expect(await first).toEqual(answer);
	expect(h.chat.deliveries?.size ?? 0).toBe(0);
	expect(h.chat.preempting).toBeUndefined();
}

/** Makes the next save that runs while a waiting turn is handed the Chat fail, once let go. */
function failingHandoff(h: ReturnType<typeof harness>) {
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let persist = h.context.persist;
	let blocked = false;
	h.context.persist = async chat => {
		if (h.chat.handoffJob && !blocked) {
			blocked = true;
			entered.resolve();
			await release.promise;
			throw new Error("database temporarily unavailable");
		}
		return persist(chat);
	};
	return { entered: entered.promise, fail: () => release.resolve() };
}

test("an instruction waiting behind a job whose last save fails is refused, and a retry is refused rather than kept waiting", async () => {
	let h = harness();
	let call = keyed(h, "Read me after the background job.");
	let job = Chat.job(h.context, JOB, "background job", "session");
	await until(() => h.prompts.length === 1);
	let write = Promise.withResolvers<void>();
	h.chat.jobWriting = write.promise;
	let first = call.invoke();
	await until(() => !!h.chat.preempting);
	h.context.persist = async () => {
		throw new Error("database temporarily unavailable");
	};
	write.resolve();
	await job;
	await h.chat.running;
	expect(h.chat.closed).toBe(true);
	expect(await first).toEqual(UNAVAILABLE);
	expect(await call.invoke()).toEqual(UNAVAILABLE);
	expect((await call.record())?.invokedAt).toBeUndefined();
	expect(h.chat.deliveries?.size ?? 0).toBe(0);
});

describe("every way a Chat stops starting turns tells the instructions waiting on it", () => {
	test("closing the Chat, as an archive or eviction does, with an instruction waiting behind a job", async () => {
		let h = harness();
		let call = keyed(h, "Wait for the job.");
		let job = Chat.job(h.context, JOB, "background job", "session");
		await until(() => h.prompts.length === 1);
		let write = Promise.withResolvers<void>();
		h.chat.jobWriting = write.promise;
		let first = call.invoke();
		await until(() => !!h.chat.preempting);
		await toldOnShutdown(h, first, () => Chat.close(h.chat));
		write.resolve();
		await job;
	});

	test("closing the Chat with an instruction given to a turn whose session is still opening", async () => {
		let h = harness();
		let call = keyed(h, "Read this when you can.");
		let opening = Promise.withResolvers<void>();
		let open = h.context.openPlannerSession!;
		h.context.openPlannerSession = async (...args) => {
			await opening.promise;
			return open(...args);
		};
		await Chat.send(h.context, socket(), member("@chopin first turn"));
		await until(() => !!h.chat.steering);
		let first = call.invoke();
		await toldOnShutdown(h, first, async () => {
			// Closing waits for the turn to end, which its session opening holds up.
			let closing = Chat.close(h.chat);
			await first;
			opening.resolve();
			await closing;
		});
	});

	test("closing the Chat while the turn an instruction was steered to has not confirmed it", async () => {
		let h = harness();
		let call = keyed(h, "Read this now.");
		let steering = Promise.withResolvers<void>();
		let session = {
			activeTools: ["read_plan"],
			async stream() {
				return { fullStream: (async function*() {})() };
			},
			// The machine never answers.
			steer: () => {
				steering.resolve();
				return new Promise<void>(() => {});
			},
			async destroy() {},
		};
		let stream = Promise.withResolvers<void>();
		session.stream = async () => ({
			fullStream: (async function*() {
				yield* await stream.promise.then(() => []);
			})(),
		});
		h.context.openPlannerSession = async () => ({ ok: true, value: session }) as never;
		await Chat.send(h.context, socket(), member("@chopin first turn"));
		await until(() => h.chat.busy && !!h.chat.steering);
		let first = call.invoke();
		await steering.promise;
		await toldOnShutdown(h, first, async () => {
			let closing = Chat.close(h.chat);
			await first;
			stream.resolve();
			await closing;
		}, { kind: "refused", code: "planner-unavailable", message: UNCONFIRMED });
		expect((await call.record())?.uncertainAt).toBeInstanceOf(Date);
	});

	test("a job's last save failing", async () => {
		let h = harness();
		let call = keyed(h, "Wait for the job.");
		let job = Chat.job(h.context, JOB, "background job", "session");
		await until(() => h.prompts.length === 1);
		let write = Promise.withResolvers<void>();
		h.chat.jobWriting = write.promise;
		let first = call.invoke();
		await until(() => !!h.chat.preempting);
		await toldOnShutdown(h, first, async () => {
			h.context.persist = async () => {
				throw new Error("database temporarily unavailable");
			};
			write.resolve();
			await job;
			await h.chat.running;
		});
		expect(h.chat.closed).toBe(true);
	});

	test("the save handing a waiting job the Chat failing, with an instruction waiting to go ahead of it", async () => {
		let h = harness();
		let call = keyed(h, "Go ahead of the job.");
		await Chat.send(h.context, socket(), member("@chopin first turn"));
		await until(() => h.prompts.length === 1);
		let job = Chat.job(h.context, JOB, "background job", "session");
		let handoff = failingHandoff(h);
		h.emit("session.idle");
		await handoff.entered;
		let first = call.invoke();
		await until(() => !!h.chat.preempting);
		await toldOnShutdown(h, first, async () => {
			handoff.fail();
			expect(await job).toMatchObject({ status: "failed" });
		});
		expect(h.chat.closed).toBe(true);
	});

	test("a stopping process letting go of the instruction waiting behind a job", async () => {
		let h = harness();
		let call = keyed(h, "Wait for the job.");
		let job = Chat.job(h.context, JOB, "background job", "session");
		await until(() => h.prompts.length === 1);
		let write = Promise.withResolvers<void>();
		h.chat.jobWriting = write.promise;
		let first = call.invoke();
		await until(() => !!h.chat.preempting);
		Chat.holdStarts();
		try {
			await toldOnShutdown(h, first, async () => {
				write.resolve();
				await job;
				await h.chat.running;
			});
		} finally {
			Chat.holdStarts(false);
		}
	});
});
