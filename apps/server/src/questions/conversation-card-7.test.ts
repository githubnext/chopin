import { expect, test } from "bun:test";

import * as Questions from "./service";
import * as Store from "./store";
import { mirrorCard } from "../conversation-plan/cards";
import { initialState } from "../conversation-plan/domain";
import { applyEvent } from "../conversation-plan/events";

import { createProcessor } from "../conversation-plan/service";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import type { Socket } from "../wire";
import { createConversationCardFixture } from "./conversation-card.test-fixtures";
import type { Plan } from "../plan/service";

let plans: Plan[];
let fixture = createConversationCardFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { OPTION, input } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("a long custom Save keeps its full answer and mirrors after a durable restart", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		"test",
		input([{ id: OPTION, label: "GitHub Apps" }]),
	);
	let question = "What auth system should we use?";
	context.plan.chat.entries.push({
		id: "m-question",
		author: { kind: "member", handle: "ana" },
		text: question,
		ts: 1,
	});
	context.plan.conversationPlan = applyEvent(initialState(), {
		id: "m-question:0:thread.opened:v1",
		type: "thread.opened",
		threadId: "thread-a",
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1,
		source: {
			messageId: "m-question",
			author: { kind: "member", handle: "ana" },
			quote: question,
			start: 0,
			end: question.length,
			role: "question",
		},
		question,
	});
	let answer = "A".repeat(600);
	let entry = Store.get(context.plan.questions, id)!;
	let questionId = entry.definition.questions[0]!.id;
	let human = entry.model.fork();
	human.api.val([questionId, "mode"]).set("custom");
	human.api.str([questionId, "custom"]).ins(0, answer);
	let patch = human.api.flush();
	if (!patch) throw new Error("custom answer made no patch");
	let replies: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			replies.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;
	await Questions.edit(context.plan, ws, {
		kind: "question:edit",
		ts: 0,
		rid: "edit",
		id,
		patch: [...patch.toBinary()],
	});
	expect(replies.at(-1)).toMatchObject({ kind: "question:edit", accepted: true });
	await Questions.submit(context.plan, context.server, "test", ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id,
		revision: Store.get(context.plan.questions, id)!.revision,
	});
	expect(replies.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
	expect(context.plan.records.get(id)?.answers?.[questionId]).toBe(answer);
	expect(context.plan.pendingCardActions).toMatchObject([{
		kind: "decided",
		text: `${"A".repeat(499)}…`,
	}]);
	await Service.close(context.plan);
	plans = [];
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(restored);
	expect(restored.records.get(id)?.answers?.[questionId]).toBe(answer);
	let processor = createProcessor({
		plan: restored,
		exclusive: action => Service.exclusive(restored, action),
		persist: () => Service.persistExclusive(restored),
		publish: () => {},
		active: () => true,
	});
	try {
		await mirrorCard(restored, processor);
		expect(restored.pendingCardActions).toEqual([]);
		expect(restored.conversationPlan.threads[0]?.decisionHistory[0]?.text.length)
			.toBeLessThanOrEqual(500);
	} finally {
		processor.stop();
	}
});

test("failed card Save does not enqueue a half-committed mirror action", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		"test",
		input([{ id: OPTION, label: "Auth0" }]),
	);
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m1"],
		}),
	).toBe(true);
	let original = context.storage.collaboration.commit;
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send() {},
		publish() {},
	} as unknown as Socket;
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		throw new Error("storage unavailable");
	};
	try {
		await Questions.submit(context.plan, context.server, "test", ws, {
			kind: "question:submit",
			ts: 0,
			rid: "save",
			id,
			revision: 1,
			suggestedOptionId: OPTION,
		});
	} finally {
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	expect(context.plan.records.get(id)!.status).toBe("open");
	expect(context.plan.pendingCardActions).toEqual([]);
	expect(context.plan.conversationPlanPendingEffects).toEqual([]);
});

test("a full prose outbox refuses Save before any answered record or node is published", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		"test",
		input([{ id: OPTION, label: "Auth0" }]),
	);
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m1"],
		}),
	).toBe(true);
	context.plan.conversationPlanPendingEffects = Array.from({ length: 1024 }, (_, index) => ({
		key: `job:heading:document:${index}`,
		kind: "job" as const,
		intent: { kind: "heading" as const, target: "document", trigger: `m${index}` },
	}));
	let before = room.project(context.plan.document);
	let beforeFrames = context.broadcasts.length;
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			frames.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;
	await Questions.submit(context.plan, context.server, "test", ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id,
		revision: 1,
		suggestedOptionId: OPTION,
	});
	expect(frames.some(frame => frame.kind === "question:submit" && frame.ok === true)).toBe(false);
	expect(context.plan.records.get(id)?.status).toBe("open");
	expect(Store.get(context.plan.questions, id)?.claim).toBeUndefined();
	expect(room.project(context.plan.document)).toBe(before);
	expect(context.plan.pendingCardActions).toEqual([]);
	expect(context.plan.conversationPlanPendingEffects).toHaveLength(1024);
	expect(context.broadcasts).toHaveLength(beforeFrames);
});
