import { expect, test } from "bun:test";
import * as Question from "@chopin/question";

import * as Questions from "./questions/service";
import * as Store from "./questions/store";
import * as room from "./plan/room";
import * as Service from "./plan/service";

import { openPlan } from "./testing/plan";

import type { Plan } from "./plan/service";

import { createQuestionServiceFixture } from "./question-service.test-fixtures";

let plans: Plan[];
let fixture = createQuestionServiceFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { definition, asking, selectFirstOption, member } = fixture;

// Retained durability scenarios share the existing draft-selection helper.
test("a rejected discard commit keeps the selected draft, record, revision, and waiter", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let open = Store.snapshot(plan.questions, id);
	if (!open.open) throw new Error("question was not open");
	let question = open.definition.questions[0]!;
	let option = question.options[0]!.id;
	let ana = member();
	await selectFirstOption(plan, ana.ws, id);
	let source = room.project(plan.document);
	let revision = plan.revision;
	let draftRevision = Store.get(plan.questions, id)!.revision;
	let storedBefore = await context.storage.collaboration.load(context.channel.id, context.now);
	let broadcasts = context.broadcasts.length;
	let events: Questions.CardEvent[] = [];
	let off = Questions.listen(plan, event => events.push(event));
	let settled = false;
	void asked.waiting.then(() => settled = true);
	let original = context.storage.collaboration.commit;
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		entered.resolve();
		await release.promise;
		throw new Error("storage unavailable");
	};
	try {
		let pending = Questions.discard(plan, context.server, "test", ana.ws, {
			kind: "question:discard",
			ts: 0,
			rid: "failed",
			id,
		});
		await entered.promise;
		expect(ana.frames.find(frame => frame.rid === "failed")).toBeUndefined();
		expect(room.project(plan.document)).toBe(source);
		expect(plan.records.get(id)?.status).toBe("open");
		expect(Store.get(plan.questions, id)?.revision).toBe(draftRevision);
		release.resolve();
		await pending;
	} finally {
		release.resolve();
		(context.storage.collaboration as { commit: typeof original }).commit = original;
		off();
	}

	expect(ana.frames.find(frame => frame.rid === "failed")).toMatchObject({
		kind: "question:discard",
		ok: false,
		reason: "resolving",
	});
	expect(plan.revision).toBe(revision);
	expect(room.project(plan.document)).toBe(source);
	expect(plan.records.get(id)?.status).toBe("open");
	expect(Store.get(plan.questions, id)?.revision).toBe(draftRevision);
	expect(Store.get(plan.questions, id)?.claim).toBeUndefined();
	expect(Question.read(Store.get(plan.questions, id)!.model, open.definition)[question.id]!.choice)
		.toBe(option);
	expect(settled).toBe(false);
	expect(events).toEqual([]);
	expect(context.broadcasts).toHaveLength(broadcasts);
	let storedAfter = await context.storage.collaboration.load(context.channel.id, context.now);
	expect(storedAfter).toEqual(storedBefore);
	await Questions.discard(plan, context.server, "test", ana.ws, {
		kind: "question:discard",
		ts: 0,
		rid: "retry",
		id,
	});
	expect(ana.frames.find(frame => frame.rid === "retry")).toMatchObject({ ok: true });
	expect(await asked.waiting).toEqual([{ status: "cancelled", resolver: "ana" }]);
});

test("a queued discard reads the decision committed ahead of it", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let open = Store.snapshot(plan.questions, id);
	if (!open.open) throw new Error("question was not open");
	let question = open.definition.questions[0]!;
	let option = question.options[0]!.id;
	let ana = member("ana");
	let ben = member("ben");
	await selectFirstOption(plan, ana.ws, id);
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let blocker = Service.exclusive(plan, async () => {
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	let events: Questions.CardEvent[] = [];
	let off = Questions.listen(plan, event => events.push(event));
	let submitting = Questions.submit(plan, context.server, "test", ana.ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id,
		revision: Store.get(plan.questions, id)!.revision,
	});
	let discarding = Questions.discard(plan, context.server, "test", ben.ws, {
		kind: "question:discard",
		ts: 0,
		rid: "discard",
		id,
	});
	try {
		expect(ben.frames.find(frame => frame.rid === "discard")).toBeUndefined();
	} finally {
		release.resolve();
		await Promise.all([blocker, submitting, discarding]);
		off();
	}

	expect(await asked.waiting).toMatchObject([{ status: "answered", resolver: "ana" }]);
	expect(ana.frames.find(frame => frame.rid === "save")).toMatchObject({ ok: true });
	expect(ben.frames.find(frame => frame.rid === "discard")).toMatchObject({ ok: true });
	expect(plan.records.get(id)).toMatchObject({
		status: "discarded",
		owner: "ana",
		resolver: "ben",
	});
	expect(room.project(plan.document)).toContain(`<Answer value="Choose this" choices="${option}"`);
	expect(room.project(plan.document)).toContain('status="discarded"');
	expect(context.broadcasts.filter(frame => frame.kind === "question:resolved")).toHaveLength(1);
	expect(events.map(event => event.kind)).toEqual(["decided", "discarded"]);
});
