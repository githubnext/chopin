import { expect, test } from "bun:test";
import type { Chat as ChatWire, ConversationPlan } from "@chopin/protocol";
import * as Chat from "../chat/service";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { createConversationRuntime } from "./runtime";
import { greetJoinedPlan, readyPlan, recoverAttachedPlan } from "./service-opening";
import { deferred } from "./service-opening-memory.test-fixtures";
import type { Room } from "../rooms";
import type { Socket } from "../wire";

function memberSocket() {
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "test", principalId: "U_test" },
		send(value: string) {
			frames.push(JSON.parse(value));
		},
	} as unknown as Socket;
	return { ws, frames };
}

test("a queued real Memory greeting refuses a retired room before sending any snapshot", async () => {
	let opened = await openPlan();
	let plan = opened.plan;
	let target: Room = { id: plan.id, plan, members: new Map() };
	let entered = deferred();
	let release = deferred();
	let joiner = memberSocket();
	let held = Plan.exclusive(plan, async () => {
		entered.resolve();
		await release.promise;
	});
	try {
		await entered.promise;
		let greeting = greetJoinedPlan(
			plan,
			joiner.ws,
			{
				kind: "plan:open",
				ts: 0,
				rid: "retired-join",
			},
			true,
			() => target.plan === plan,
		);
		let result = greeting.then(() => undefined, error => error);
		await Bun.sleep(2);
		expect(joiner.frames).toEqual([]);
		target.plan = undefined;
		release.resolve();
		await held;
		let error = await result;
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("document is unavailable");
		expect(joiner.frames).toEqual([]);
	} finally {
		release.resolve();
		await held;
		await Plan.close(plan);
	}
});

test("a published plan waits for actual runtime replacement drain before binding and sending", async () => {
	let opened = await openPlan();
	let plan = opened.plan;
	let target: Room = { id: plan.id, plan, members: new Map() };
	let firstId = crypto.randomUUID();
	let requestId = crypto.randomUUID();
	let interpreting = deferred();
	let aborted = deferred();
	let release = deferred();
	let secondInterpreting = deferred();
	let secondRelease = deferred();
	let firstRuns = 0;
	let errors: unknown[] = [];
	let runtime = createConversationRuntime({
		config: { agent: false, conversationPlan: true },
		server: () => opened.server,
		unavailable: () => false,
		interpret: async (input, signal) => {
			if (input.message.id === firstId && firstRuns++ === 0) {
				interpreting.resolve();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				// Only the injected inference boundary is held, even after observing abort.
				await release.promise;
				if (signal.aborted) throw signal.reason;
			}
			if (input.message.id === requestId) {
				secondInterpreting.resolve();
				await secondRelease.promise;
			}
			return {
				events: [],
				analysis: {
					status: "unlinked",
					questionSetVersion: "test",
					modelVersion: "offline",
					passes: [],
				},
			};
		},
		onError: error => errors.push(error),
	});
	let context = () =>
		runtime.bind({
			chat: plan.chat,
			plan,
			server: opened.server,
			room: target.id,
			config: { agent: false } as Chat.Room["config"],
			auth: {} as Chat.Room["auth"],
			claimantSessionId: "test-session",
			repository: { id: "R_test", owner: "owner", name: "repository", defaultBranch: "main" },
			persist: () => Plan.persist(plan),
		});
	let sending: Promise<void> | undefined;
	try {
		await runtime.attach(target, plan, false);
		await Chat.send(context(), memberSocket().ws, {
			kind: "chat:send",
			ts: 0,
			rid: "initial-send",
			requestId: firstId,
			to: "room",
			text: "Use an optional outline.",
		});
		await interpreting.promise;
		// The actual replacement attach waits for the old processor's held idle drain.
		// This fixture supplies main's shared opening promise, not its socket/auth execution.
		target.opening = runtime.attach(target, plan, false).then(() => plan);
		await aborted.promise;
		let sender = memberSocket();
		let bound = false;
		sending = (async () => {
			let current = await readyPlan(target);
			expect(current).toBe(plan);
			let boundContext = context();
			bound = true;
			expect(boundContext.commitRoomMessage).toBeFunction();
			await Chat.send(boundContext, sender.ws, {
				kind: "chat:send",
				ts: 0,
				rid: "published-send",
				requestId,
				to: "room",
				text: "Should we use an optional outline?",
			});
		})();
		await Bun.sleep(2);
		expect(target.plan).toBe(plan);
		expect(runtime.processor(plan)).toBeUndefined();
		expect(bound).toBe(false);
		expect(sender.frames).toEqual([]);
		expect(plan.chat.entries.map(entry => entry.id)).toEqual([firstId]);
		release.resolve();
		await Promise.all([target.opening, sending, secondInterpreting.promise]);
		expect(runtime.processor(plan)).toBeDefined();
		expect(bound).toBe(true);
		expect(sender.frames).toContainEqual(expect.objectContaining({
			kind: "chat:send",
			rid: "published-send",
			id: requestId,
		}));
		let loaded = (await opened.storage.collaboration.load(plan.id, new Date()))!;
		let sidecar = (loaded.sidecar ?? loaded.snapshot!.sidecar) as unknown as {
			transcript: ChatWire.Entry[];
			conversationPlan: ConversationPlan.State;
		};
		expect(sidecar.transcript.map(entry => entry.id)).toEqual([firstId, requestId]);
		expect(sidecar.conversationPlan.queue.filter(item => item.messageId === requestId)).toEqual([
			{ messageId: requestId, status: "pending", attempts: 0 },
		]);
	} finally {
		release.resolve();
		secondRelease.resolve();
		await target.opening;
		await sending;
		await runtime.stop(plan);
		await Plan.close(plan);
	}
	expect(errors).toEqual([]);
});

test("recovery waits for the real held runtime attachment before attaching again", async () => {
	let opened = await openPlan();
	let plan = opened.plan;
	let target: Room = { id: plan.id, plan, members: new Map() };
	let entered = deferred();
	let aborted = deferred();
	let release = deferred();
	let first = true;
	let recovering = false;
	let attachments = 0;
	let errors: unknown[] = [];
	let runtime = createConversationRuntime({
		config: { agent: false, conversationPlan: true },
		server: () => {
			attachments++;
			return opened.server;
		},
		unavailable: () => false,
		interpret: async (_input, signal) => {
			if (first) {
				first = false;
				entered.resolve();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await release.promise;
				if (signal.aborted) throw signal.reason;
			}
			return {
				events: [],
				analysis: {
					status: "unlinked",
					questionSetVersion: "test",
					modelVersion: "offline",
					passes: [],
				},
			};
		},
		onError: error => errors.push(error),
	});
	let recovery: Promise<Plan.Plan | undefined> | undefined;
	try {
		await runtime.attach(target, plan, false);
		await Chat.send(
			runtime.bind({
				chat: plan.chat,
				plan,
				server: opened.server,
				room: target.id,
				config: { agent: false } as Chat.Room["config"],
				auth: {} as Chat.Room["auth"],
				claimantSessionId: "test-session",
				repository: { id: "R_test", owner: "owner", name: "repository", defaultBranch: "main" },
				persist: () => Plan.persist(plan),
			}),
			memberSocket().ws,
			{
				kind: "chat:send",
				ts: 0,
				rid: "recovery-send",
				requestId: crypto.randomUUID(),
				to: "room",
				text: "Use an optional outline.",
			},
		);
		await entered.promise;
		target.opening = runtime.attach(target, plan, false).then(() => plan);
		await aborted.promise;
		recovery = recoverAttachedPlan(target).then(async current => {
			recovering = true;
			if (current) await runtime.attach(target, current, false);
			return current;
		});
		await Bun.sleep(2);
		expect(target.plan).toBe(plan);
		expect(recovering).toBe(false);
		expect(attachments).toBe(1);
		expect(runtime.processor(plan)).toBeUndefined();
		release.resolve();
		let [, recovered] = await Promise.all([target.opening, recovery]);
		expect(recovered).toBe(plan);
		expect(recovering).toBe(true);
		expect(attachments).toBe(3);
		expect(runtime.processor(plan)).toBeDefined();
	} finally {
		release.resolve();
		await target.opening;
		await recovery;
		await runtime.stop(plan);
		await Plan.close(plan);
	}
	expect(errors).toEqual([]);
});

test("recovery after a rejected opening keeps a useful published Memory plan and tolerates none", async () => {
	let opened = await openPlan();
	let target: Room = { id: opened.plan.id, plan: opened.plan, members: new Map() };
	try {
		target.opening = Promise.reject(new Error("attachment failed"));
		expect(await recoverAttachedPlan(target)).toBe(opened.plan);
		target.plan = undefined;
		target.opening = Promise.reject(new Error("opening failed before publication"));
		expect(await recoverAttachedPlan(target)).toBeUndefined();
		expect(await recoverAttachedPlan(undefined)).toBeUndefined();
	} finally {
		await Plan.close(opened.plan);
	}
});
