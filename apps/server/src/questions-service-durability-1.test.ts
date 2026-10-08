import { expect, test } from "bun:test";

import * as Questions from "./questions/service";
import * as Store from "./questions/store";
import * as room from "./plan/room";

import { openPlan } from "./testing/plan";

import type { Plan } from "./plan/service";

import { createQuestionServiceFixture } from "./question-service.test-fixtures";

let plans: Plan[];
let fixture = createQuestionServiceFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { restart, definition, asking, selectFirstOption, member } = fixture;

// Retained durability scenarios share the existing draft-selection helper.
test("discarding an open card commits its hidden node before releasing the Planner", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let ana = member();
	let events: Questions.CardEvent[] = [];
	let off = Questions.listen(plan, event => events.push(event));
	let before = context.broadcasts.length;

	await Questions.discard(plan, context.server, "test", ana.ws, {
		kind: "question:discard",
		ts: 0,
		rid: "discard",
		id,
	});
	off();

	expect(await asked.waiting).toEqual([{ status: "cancelled", resolver: "ana" }]);
	expect(ana.frames.at(-1)).toMatchObject({ kind: "question:discard", ok: true, resolver: "ana" });
	expect(plan.records.get(id)).toMatchObject({ status: "discarded", resolver: "ana" });
	expect(room.project(plan.document)).toContain(
		`thread="${plan.records.get(id)?.threadId}" status="discarded"`,
	);
	expect(Store.snapshot(plan.questions, id).open).toBe(false);
	expect(
		context.broadcasts.slice(before).map(frame => frame.kind)
			.filter(kind => kind !== "session:decisions"),
	).toEqual([
		"plan:update",
		"question:resolved",
		"question:meta",
	]);
	expect(events).toEqual([{
		kind: "discarded",
		id,
		threadId: plan.records.get(id)?.threadId,
		actor: "ana",
	}]);
	let reopened = await restart(context);
	expect(reopened.records.get(id)).toMatchObject({ status: "discarded", resolver: "ana" });
	expect(room.project(reopened.document)).toContain(
		`thread="${reopened.records.get(id)?.threadId}" status="discarded"`,
	);
	expect(Questions.meta(reopened, reopened.records.get(id)!)).toMatchObject({
		status: "discarded",
		resolver: "ana",
	});
});

test("discarding a decided card retains its answer, prose, and original decider", async () => {
	let context = await openPlan("Decision prose.\n");
	let plan = context.plan;
	plans.push(plan);
	let digest = room.digests(plan.document)[0]!;
	let asked = asking(plan, context.server, definition(), {
		revision: plan.revision,
		blocks: [[{ index: 0, digest }]],
	});
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let question = plan.records.get(id)!.definition.questions[0]!;
	let option = question.options[0]!.id;
	let opened = Store.snapshot(plan.questions, id);
	if (!opened.open) throw new Error("question was not open");
	let ana = member("ana");
	await selectFirstOption(plan, ana.ws, id);
	await Questions.submit(plan, context.server, "test", ana.ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id,
		revision: Store.get(plan.questions, id)!.revision,
	});
	await asked.waiting;
	let answered = plan.records.get(id)!;
	let prose = room.anchorAt(plan.document, 0, room.digests(plan.document)[0]!);
	let history = [{ choices: [option], owner: "earlier", at: 1 }];
	plan.records.set(id, { ...answered, prose: [prose], history });
	let source = room.project(plan.document);
	let ben = member("ben");

	await Questions.discard(plan, context.server, "test", ben.ws, {
		kind: "question:discard",
		ts: 0,
		rid: "discard",
		id,
	});

	let after = room.project(plan.document);
	expect(ben.frames.at(-1)).toMatchObject({ ok: true, resolver: "ben" });
	expect(after).toBe(source.replace('status="decided"', 'status="discarded"'));
	expect(after).toContain("Decision prose.");
	expect(after).toContain(`<Answer value="Choose this" choices="${option}"`);
	expect(after).toContain('by="ana"');
	expect(plan.records.get(id)).toMatchObject({
		status: "discarded",
		owner: "ana",
		resolver: "ben",
		choices: [option],
		prose: [prose],
		history,
	});
	let reopened = await restart(context);
	expect(reopened.records.get(id)).toMatchObject({
		status: "discarded",
		owner: "ana",
		resolver: "ben",
		prose: [prose],
		history,
	});
	expect(Questions.meta(reopened, reopened.records.get(id)!)).toMatchObject({
		status: "discarded",
		resolver: "ben",
	});
});

test("a discarded or unknown card cannot be discarded again", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let ana = member();
	let before = context.broadcasts.length;
	let request = (rid: string, target = id) =>
		Questions.discard(
			plan,
			context.server,
			"test",
			ana.ws,
			{ kind: "question:discard", ts: 0, rid, id: target },
		);
	await request("first");
	await asked.waiting;
	let after = context.broadcasts.length;
	await request("second");
	await request("unknown", "missing");

	expect(ana.frames.find(frame => frame.rid === "second")).toMatchObject({
		ok: false,
		reason: "resolved",
		status: "discarded",
		resolver: "ana",
	});
	expect(ana.frames.find(frame => frame.rid === "unknown")).toMatchObject({
		ok: false,
		reason: "resolved",
		status: "discarded",
		resolver: "system",
	});
	expect(after).toBeGreaterThan(before);
	expect(context.broadcasts).toHaveLength(after);
});
