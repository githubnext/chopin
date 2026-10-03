import { expect, test } from "bun:test";

import * as Questions from "./questions/service";

import * as room from "./plan/room";

import { replay } from "./conversation-plan/domain";
import { buildTargetingRequest } from "./conversation-plan/questions";
import { extractQuotes } from "./conversation-plan/quotes";
import { openPlan } from "./testing/plan";
import type { Server } from "bun";
import type { Plan } from "./plan/service";
import type { Socket, SocketData } from "./wire";
import { createQuestionServiceFixture } from "./question-service.test-fixtures";

let plans: Plan[];
let fixture = createQuestionServiceFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { opened, restart, definition, asking } = fixture;

// Retained durability scenarios adapted to the keyed shared-option protocol.
test("Planner ask links each card to a durable, targetable thread with its original options", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let value = definition(2);
	let asked = asking(plan, context.server, value);
	await asked.created;

	let records = [...plan.records.values()];
	expect(records).toHaveLength(2);
	expect(plan.conversationPlan.threads).toHaveLength(2);
	for (let [index, record] of records.entries()) {
		let question = value.questions[index]!;
		let thread = plan.conversationPlan.threads[index]!;
		expect(record.threadId).toBe(thread.id);
		expect(thread).toMatchObject({
			question: question.question,
			questionSources: [],
			questionAuthoring: "scribe",
			questionnaireId: record.id,
			status: "exploring",
		});
		expect(thread.contributions.map(option => ({
			id: option.id,
			text: option.text,
			sources: option.sources,
		}))).toEqual(question.options.map(option => ({
			id: option.id,
			text: option.label,
			sources: [],
		})));
		expect(room.project(plan.document)).toContain(`thread="${thread.id}"`);
	}
	let quoted = value.questions[0]!.options[0]!.label;
	let message = {
		id: "exact-option-quote",
		author: { kind: "member" as const, handle: "ana" },
		text: `I support ${quoted}.`,
		ts: 1,
	};
	let request = buildTargetingRequest(
		message,
		[],
		plan.conversationPlan.threads,
		extractQuotes(message.text),
	);
	let criteria = (request.questions.c0_option as { criteria: Record<string, string> }).criteria;
	expect(criteria[value.questions[0]!.options[0]!.id]).toContain(quoted);
	expect(
		(request.questions.c0_thread as { criteria: Record<string, string> })
			.criteria[records[0]!.threadId!],
	).toContain(value.questions[0]!.question);

	let reopened = await restart(context);
	expect(
		[...reopened.records.values()].map(record => ({ id: record.id, threadId: record.threadId })),
	)
		.toEqual(records.map(record => ({ id: record.id, threadId: record.threadId })));
	expect(reopened.conversationPlan).toEqual(plan.conversationPlan);
	expect(replay(reopened.conversationPlan.events).threads).toEqual(
		reopened.conversationPlan.threads,
	);
	expect(room.project(reopened.document)).toEqual(room.project(plan.document));
});

test("an active implementation leaves an open questionnaire in the plan when discarding is refused", async () => {
	let plan = await opened();
	let server = { publish() {} } as unknown as Server<SocketData>;
	let asked = asking(plan, server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let replies: Array<{ kind: string; message?: string; rid?: string; ts?: number }> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			replies.push(JSON.parse(raw));
		},
	} as unknown as Socket;
	plan.execution = { id: "run-1" } as never;

	await Questions.discard(plan, server, "test", ws, {
		kind: "question:discard",
		ts: 0,
		rid: "cancel",
		id,
	});

	expect(replies).toEqual([{
		kind: "session:error",
		message: "implementation is active",
		ts: expect.any(Number),
		rid: "cancel",
	}]);
	expect(plan.records.get(id)?.status).toBe("open");
	expect(room.project(plan.document)).toContain("<Questionnaire");
	plan.execution = undefined;
	await Questions.discard(plan, server, "test", ws, {
		kind: "question:discard",
		ts: 0,
		rid: "cleanup",
		id,
	});
	await asked.waiting;
});

test("a reopened decision can still grow an option", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let record = [...plan.records.values()][0]!;
	plan.records.set(record.id, { ...record, status: "reopened" });
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			frames.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;

	await Questions.addOption(plan, context.server, "test", ws, {
		kind: "question:option",
		question: plan.records.get(record.id)!.definition.questions[0]!.id,
		key: "add-option-1",
		ts: 0,
		rid: "grow",
		id: record.id,
		label: "GitHub Apps",
	});
	expect(frames.find(frame => frame.kind === "question:option")).toMatchObject({
		ok: true,
		id: record.id,
	});
	expect(plan.records.get(record.id)?.status).toBe("reopened");
	await Questions.discard(plan, context.server, "test", ws, {
		kind: "question:discard",
		ts: 0,
		rid: "cleanup",
		id: record.id,
	});
	await asked.waiting;
});
