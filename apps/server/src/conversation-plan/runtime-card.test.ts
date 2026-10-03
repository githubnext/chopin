import { expect, test } from "bun:test";
import * as Chat from "../chat/service";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { createConversationRuntime } from "./runtime";
import { interpretMessage } from "./interpret";
import { mockResult } from "./interpret.test-fixtures";
import { until } from "./service.test-fixtures";
import type { Room } from "../rooms";
import type { Socket } from "../wire";

// Offline synthetic model answers exercise the production interpreter and card consumers.
test("runtime saves a room message, projects a durable decision card, and reopens without duplicating it", async () => {
	let opened = await openPlan();
	let plan = opened.plan;
	let room: Room = { id: plan.id, plan, members: new Map() };
	let errors: unknown[] = [];
	let config = { agent: false, conversationPlan: true };
	let runtime = createConversationRuntime({
		config,
		server: () => opened.server,
		unavailable: () => false,
		onError: error => errors.push(error),
		interpret: input =>
			interpretMessage({
				...input,
				ask: async request =>
					mockResult(request.questions, {
						new_question: 0.95,
						enough_purpose: 0.95,
						act: "question",
						thread_target: "new",
						c0_role: "question",
						c0_thread: "new",
						c0_duplicate: 0.05,
					}),
			}),
	});
	let context = runtime.bind({
		chat: plan.chat,
		plan,
		server: opened.server,
		room: plan.id,
		config: config as Chat.Room["config"],
		persist: () => Plan.persist(plan),
	} as Chat.Room);
	let socket = { data: { handle: "test", principalId: "U_test" }, send() {} } as unknown as Socket;
	let stopped: Promise<void> | undefined;
	try {
		await runtime.attach(room, plan, false);
		runtime.bind(context);
		await Chat.send(context, socket, {
			kind: "chat:send",
			rid: "send",
			requestId: crypto.randomUUID(),
			to: "room",
			text: "Which authentication system should we use?",
			ts: 0,
		});
		await until(() =>
			plan.conversationPlan.threads[0]?.questionnaireId !== undefined
			&& plan.conversationPlanPendingEffects.length === 0
		);
		await runtime.jobs(plan)?.idle();
		let thread = plan.conversationPlan.threads[0]!;
		let card = plan.records.get(thread.questionnaireId!)!;
		expect(card.origin).toBe("conversation");
		expect(card.threadId).toBe(thread.id);
		expect(card.status).toBe("open");
		expect(Plan.source(plan)).toContain(thread.questionnaireId!);
		let loaded = (await opened.storage.collaboration.load(plan.id, opened.now))!;
		let sidecar = (loaded.sidecar ?? loaded.snapshot!.sidecar) as unknown as {
			transcript: typeof plan.chat.entries;
			conversationPlan: typeof plan.conversationPlan;
			conversationPlanEffects: string[];
		};
		expect(sidecar.transcript[0]?.text).toBe("Which authentication system should we use?");
		expect(sidecar.conversationPlan.threads[0]?.questionnaireId).toBe(card.id);
		expect(sidecar.conversationPlanEffects).toContain(`insert:${thread.id}`);
		expect(sidecar.conversationPlan.analysis[0]?.status).toBe("applied");
		stopped = runtime.stop(plan);
		await stopped;
		await Plan.close(plan);
		plan = await Plan.open(opened.channel.id, opened.backend, opened.server);
		room.plan = plan;
		await runtime.attach(room, plan, false);
		await Bun.sleep(10);
		expect(plan.records.size).toBe(1);
		expect(plan.conversationPlan.threads[0]?.questionnaireId).toBe(card.id);
		expect(plan.conversationPlanPendingEffects).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		stopped = runtime.stop(plan);
		await stopped;
		await Plan.close(plan);
	}
});

test("disabled and archived runtime cannot accept a queued conversation mutation", async () => {
	let opened = await openPlan();
	let plan = opened.plan;
	let room: Room = { id: plan.id, plan, members: new Map() };
	let disabled = createConversationRuntime({
		config: { agent: false },
		server: () => opened.server,
		unavailable: () => false,
	});
	let archived = createConversationRuntime({
		config: { agent: false, conversationPlan: true },
		server: () => opened.server,
		unavailable: () => false,
	});
	try {
		await disabled.attach(room, plan, false);
		expect(disabled.processor(plan)).toBeUndefined();
		await archived.attach(room, plan, true);
		expect(archived.jobs(plan)).toBeUndefined();
		await expect(
			archived.processor(plan)!.accept({
				id: "blocked",
				author: { kind: "member", handle: "test" },
				text: "Which approach?",
				ts: 0,
			}),
		).rejects.toThrow("unavailable");
		expect(plan.chat.entries).toEqual([]);
		expect(plan.conversationPlan.queue).toEqual([]);
	} finally {
		await archived.stop(plan);
		await Plan.close(plan);
	}
});
