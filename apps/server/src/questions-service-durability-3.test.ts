import { expect, test } from "bun:test";
import * as Question from "@chopin/question";

import * as Questions from "./questions/service";
import * as Store from "./questions/store";
import * as room from "./plan/room";
import * as Service from "./plan/service";

import { openPlan, storedQuestion } from "./testing/plan";

import type { Plan } from "./plan/service";

import { createQuestionServiceFixture } from "./question-service.test-fixtures";

let plans: Plan[];
let fixture = createQuestionServiceFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { definition, asking, member } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
test("an implementation started ahead of a queued discard leaves the card open", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let source = room.project(plan.document);
	let revision = plan.revision;
	let broadcasts = context.broadcasts.length;
	let ana = member();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let blocker = Service.exclusive(plan, async () => {
		entered.resolve();
		await release.promise;
		plan.execution = { id: "run-1" } as never;
	});
	await entered.promise;
	let discarding = Questions.discard(plan, context.server, "test", ana.ws, {
		kind: "question:discard",
		ts: 0,
		rid: "blocked",
		id,
	});
	try {
		expect(ana.frames.find(frame => frame.rid === "blocked")).toBeUndefined();
	} finally {
		release.resolve();
		await Promise.all([blocker, discarding]);
	}

	expect(ana.frames.find(frame => frame.rid === "blocked")).toMatchObject({
		kind: "session:error",
		message: "implementation is active",
	});
	expect(room.project(plan.document)).toBe(source);
	expect(plan.records.get(id)?.status).toBe("open");
	expect(Store.snapshot(plan.questions, id).open).toBe(true);
	expect(plan.revision).toBe(revision);
	expect(context.broadcasts).toHaveLength(broadcasts);
	plan.execution = undefined;
	await Questions.discard(plan, context.server, "test", ana.ws, {
		kind: "question:discard",
		ts: 0,
		rid: "cleanup",
		id,
	});
	await asked.waiting;
});

test("a reopened card can be discarded while its draft is live", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	await Service.exclusive(plan, async () => {
		plan.records.set(id, { ...plan.records.get(id)!, status: "reopened" });
		let mutation = room.projectCard(plan.document, id, { status: "reopened" });
		if (!mutation) throw new Error("card projection did not change");
		await Service.publish(plan, context.server, "test", mutation);
	});
	let ana = member();
	await Questions.discard(plan, context.server, "test", ana.ws, {
		kind: "question:discard",
		ts: 0,
		rid: "discard",
		id,
	});

	expect(ana.frames.at(-1)).toMatchObject({ ok: true, resolver: "ana" });
	expect(await asked.waiting).toEqual([{ status: "cancelled", resolver: "ana" }]);
	expect(plan.records.get(id)?.status).toBe("discarded");
	expect(room.project(plan.document)).toContain('status="discarded"');
});

test("discard refuses a missing document projection without changing the record or draft", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	await Service.exclusive(plan, async () => {
		let mutation = room.removeQuestionnaire(plan.document, id);
		if (!mutation) throw new Error("card was not in the document");
		await Service.publish(plan, context.server, "test", mutation);
	});
	let record = plan.records.get(id)!;
	let revision = plan.revision;
	let broadcasts = context.broadcasts.length;
	let ana = member();
	let events: Questions.CardEvent[] = [];
	let off = Questions.listen(plan, event => events.push(event));
	await Questions.discard(plan, context.server, "test", ana.ws, {
		kind: "question:discard",
		ts: 0,
		rid: "missing",
		id,
	});
	off();

	expect(ana.frames.at(-1)).toMatchObject({
		kind: "question:discard",
		ok: false,
		reason: "resolving",
	});
	expect(plan.records.get(id)).toBe(record);
	expect(Store.snapshot(plan.questions, id).open).toBe(true);
	expect(Store.get(plan.questions, id)?.claim).toBeUndefined();
	expect(plan.revision).toBe(revision);
	expect(context.broadcasts).toHaveLength(broadcasts);
	expect(events).toEqual([]);
	void asked.waiting;
});

test("legacy question records gain card defaults on restore", async () => {
	let value = definition();
	let { plan } = await openPlan("", {
		questions: [{
			id: "w1",
			definition: value,
			status: "answered",
			answers: {},
			resolver: "ana",
			at: 1,
		}],
	});
	plans.push(plan);
	expect(plan.records.get("w1")).toMatchObject({
		status: "answered",
		origin: "planner",
		history: [],
		optionOrigins: {},
		editors: [],
		owner: "ana",
		decidedAt: 1,
	});
});

test("restore rejects orphaned or duplicate open drafts and records", async () => {
	let value = definition();
	let single = Question.decision(value);
	let record = { id: "w1", definition: value, status: "open" };
	let draft = {
		id: "w1",
		definition: single,
		widget: "w1",
		model: storedQuestion(single),
		revision: 0,
	};
	await expect(openPlan("", { questions: [], openQuestions: [draft] })).rejects.toThrow(
		"question records disagree with their drafts",
	);
	await expect(openPlan("", { questions: [record, record], openQuestions: [draft] }))
		.rejects.toThrow("invalid or duplicate question record id");
	await expect(openPlan("", { questions: [record], openQuestions: [draft, draft] }))
		.rejects.toThrow("invalid or duplicate open questionnaire id");
});

test("a reopened record restores only with its open draft", async () => {
	let value = definition();
	let single = Question.decision(value);
	let record = {
		id: "w1",
		definition: value,
		status: "reopened",
		origin: "conversation",
		history: [{ choices: [value.questions[0]!.options[0]!.id], owner: "ana", at: 1 }],
		optionOrigins: {},
		editors: [],
	};
	let { plan } = await openPlan("", {
		questions: [record],
		openQuestions: [{
			id: "w1",
			definition: single,
			widget: "w1",
			model: storedQuestion(single),
			revision: 0,
		}],
	});
	plans.push(plan);
	expect(plan.records.get("w1")?.status).toBe("reopened");
	expect(Store.get(plan.questions, "w1")).toBeDefined();
	await expect(openPlan("", { questions: [record] })).rejects.toThrow(
		"question records disagree with their drafts",
	);
});
