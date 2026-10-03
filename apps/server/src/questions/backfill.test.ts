import { afterEach, expect, test } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";

import { buildTargetingRequest } from "../conversation-plan/questions";
import { extractQuotes } from "../conversation-plan/quotes";
import { applyEvent } from "../conversation-plan/events";
import { publishOpenedPlan } from "../conversation-plan/service-opening";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan, storedQuestion } from "../testing/plan";
import { backfillPlannerAskThreads } from "./backfill";
import * as Questions from "./service";

import type { Questionnaire } from "@chopin/dialect";
import type { Plan } from "../plan/service";

let plans: Plan[] = [];
afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

async function source(values: Questionnaire[]): Promise<string> {
	let document = await room.create();
	try {
		room.insertQuestionnaires(document, values.map(value => ({ value })));
		return room.project(document);
	} finally {
		document.doc.destroy();
	}
}

async function legacy(overrides: {
	record?: Record<string, unknown>;
	projection?: Partial<Questionnaire>;
	copies?: number;
	optionOrigin?: "human" | "chat";
} = {}) {
	let id = ulid();
	let definition = Questions.identify({
		questions: [{
			header: "Storage",
			question: "Where should room state live?",
			multiple: false,
			options: [
				{ label: "MDX on disk", description: "Readable." },
				{ label: "PostgreSQL", description: "Shared." },
			],
		}],
	});
	let question = definition.questions[0]!;
	let value: Questionnaire = {
		id,
		questions: [{
			id: question.id,
			header: question.header,
			prompt: question.question,
			multiple: question.multiple,
			options: question.options.map(option => ({
				id: option.id,
				label: option.label,
				...(option.description ? { description: option.description } : {}),
			})),
		}],
		...overrides.projection,
	};
	let record = {
		id,
		definition,
		status: "open",
		origin: "planner",
		history: [],
		optionOrigins: overrides.optionOrigin
			? { [question.options[0]!.id]: { origin: overrides.optionOrigin } }
			: {},
		editors: [],
		...overrides.record,
	};
	let status = record.status;
	let context = await openPlan(await source(Array(overrides.copies ?? 1).fill(value)), {
		questions: [record],
		openQuestions: status === "open" || status === "reopened"
			? [{
				id,
				definition: Question.decision(definition),
				widget: id,
				model: storedQuestion(Question.decision(definition)),
				revision: 0,
			}]
			: [],
	});
	plans.push(context.plan);
	return { ...context, id, definition };
}

test("legacy Planner ask migrates once, survives reopen, and enters Jev targeting", async () => {
	let context = await legacy();
	let { plan, id, definition } = context;
	let before = {
		jobs: plan.conversationPlanJobs.length,
		effects: plan.conversationPlanEffects.length,
		pending: plan.conversationPlanPendingEffects.length,
		queue: plan.conversationPlan.queue.length,
	};
	expect(await backfillPlannerAskThreads(plan)).toBe(1);
	let record = plan.records.get(id)!;
	let thread = plan.conversationPlan.threads[0]!;
	expect(record.threadId).toBe(`planner-ask:${id}`);
	expect(thread).toMatchObject({
		id: record.threadId,
		questionnaireId: id,
		questionSources: [],
		questionAuthoring: "scribe",
	});
	expect(thread.contributions.map(item => item.id)).toEqual(
		definition.questions[0]!.options.map(option => option.id),
	);
	expect(room.project(plan.document)).toContain(`thread="${record.threadId}"`);
	expect(plan.conversationPlan.events.map(event => event.type)).toEqual([
		"thread.opened",
		"option.added",
		"option.added",
		"card.linked",
	]);
	expect({
		jobs: plan.conversationPlanJobs.length,
		effects: plan.conversationPlanEffects.length,
		pending: plan.conversationPlanPendingEffects.length,
		queue: plan.conversationPlan.queue.length,
	}).toEqual(before);
	let message = {
		id: "quote",
		author: { kind: "member" as const, handle: "ana" },
		text: "I support MDX on disk.",
		ts: 1,
	};
	let target = buildTargetingRequest(
		message,
		[],
		plan.conversationPlan.threads,
		extractQuotes(message.text),
	);
	expect((target.questions.c0_thread as { criteria: Record<string, string> }).criteria[thread.id])
		.toContain(definition.questions[0]!.question);
	expect(
		(target.questions.c0_option as { criteria: Record<string, string> })
			.criteria[definition.questions[0]!.options[0]!.id],
	).toContain("MDX on disk");

	await Service.close(plan);
	plans = [];
	let reopened = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(reopened);
	expect(reopened.records.get(id)?.threadId).toBe(thread.id);
	expect(reopened.conversationPlan).toEqual(plan.conversationPlan);
	expect(room.project(reopened.document)).toEqual(room.project(plan.document));
	expect(await backfillPlannerAskThreads(reopened)).toBe(0);
	expect(reopened.conversationPlan).toEqual(plan.conversationPlan);
});

test("first-open preparation finishes the backfill before room exposure", async () => {
	let context = await legacy();
	let opening: { plan?: Plan } = {};
	let derivedNotifications = 0;
	context.plan.persistence.onDocumentPersisted = () => derivedNotifications++;
	await publishOpenedPlan(opening, context.plan, async () => {
		expect(opening.plan).toBeUndefined();
		expect(await backfillPlannerAskThreads(context.plan)).toBe(1);
		expect(context.plan.records.get(context.id)?.threadId).toBeDefined();
		expect(opening.plan).toBeUndefined();
	});
	expect(opening.plan).toBe(context.plan);
	expect(derivedNotifications).toBe(0);
});

test("human and chat option provenance each prevent a metadata migration", async () => {
	for (let optionOrigin of ["human", "chat"] as const) {
		let context = await legacy({ optionOrigin });
		let source = room.project(context.plan.document);
		let revision = context.plan.persistence.revision;
		expect(await backfillPlannerAskThreads(context.plan)).toBe(0);
		expect(context.plan.persistence.revision).toBe(revision);
		expect(context.plan.records.get(context.id)?.threadId).toBeUndefined();
		expect(context.plan.conversationPlan.events).toEqual([]);
		expect(room.project(context.plan.document)).toBe(source);
		expect(context.broadcasts).toEqual([]);
	}
});

test("ambiguous or mismatched legacy projections are left alone", async () => {
	for (
		let input of [
			{ copies: 2 },
			{ projection: { thread: "already-linked" } },
			{ projection: { status: "reopened" as const } },
			{ projection: { id: ulid() } },
			{ record: { status: "answered" } },
			{ record: { status: "reopened" } },
		]
	) {
		let context = await legacy(input);
		let before = room.project(context.plan.document);
		expect(await backfillPlannerAskThreads(context.plan)).toBe(0);
		expect(context.plan.conversationPlan.events).toEqual([]);
		expect(context.plan.records.get(context.id)?.threadId).toBeUndefined();
		expect(room.project(context.plan.document)).toBe(before);
	}
});

test("a thread-ID collision or full conversation leaves the legacy card unchanged", async () => {
	for (let full of [false, true]) {
		let context = await legacy();
		let { plan, id } = context;
		let source = room.project(plan.document);
		let count = full ? 20 : 1;
		for (let index = 0; index < count; index++) {
			plan.conversationPlan = applyEvent(plan.conversationPlan, {
				id: `existing-${index}`,
				type: "thread.opened",
				threadId: full ? `existing-thread-${index}` : `planner-ask:${id}`,
				observedThreadVersion: 0,
				origin: "planner",
				actor: { kind: "agent" },
				at: 1,
				question: "An existing question?",
			});
		}
		expect(await backfillPlannerAskThreads(plan)).toBe(0);
		expect(plan.records.get(id)?.threadId).toBeUndefined();
		expect(room.project(plan.document)).toBe(source);
		expect(plan.conversationPlan.threads).toHaveLength(count);
	}
});

test("failed migration commit leaves live and durable card unlinked", async () => {
	let context = await legacy();
	let { plan, id } = context;
	let before = room.project(plan.document);
	let original = context.storage.collaboration.commit.bind(context.storage.collaboration);
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		throw new Error("storage unavailable");
	};
	await expect(backfillPlannerAskThreads(plan)).rejects.toThrow("storage unavailable");
	expect(plan.records.get(id)?.threadId).toBeUndefined();
	expect(plan.conversationPlan.events).toEqual([]);
	expect(room.project(plan.document)).toBe(before);
	(context.storage.collaboration as { commit: typeof original }).commit = original;
	await Service.close(plan);
	plans = [];
	let reopened = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(reopened);
	expect(reopened.records.get(id)?.threadId).toBeUndefined();
	expect(reopened.conversationPlan.events).toEqual([]);
	expect(room.project(reopened.document)).toBe(before);
});
