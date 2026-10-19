import { expect, test } from "bun:test";
import * as Question from "@chopin/question";

import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import { meta } from "./card-notifications";
import { normalizeRecord } from "./records";
import * as Questions from "./service";
import * as Store from "./store";
import { member } from "./card-reopen.test-fixtures";

import type { Plan } from "../plan/service";

async function setup() {
	let context = await openPlan();
	let plan = context.plan;
	let definition = Questions.identify({
		questions: [{
			header: "Auth",
			question: "How do we sign in?",
			multiple: false,
			options: [{ label: "Passkeys", description: "" }, { label: "Passwords", description: "" }],
			criteria: [{ label: "New device" }, { label: "Easy reset" }],
		}],
	});
	let created = Promise.withResolvers<void>();
	void Questions.ask(plan, context.server, "test", definition, undefined, created.resolve);
	await created.promise;
	let id = [...plan.records.keys()][0]!;
	return { context, plan, id, item: plan.records.get(id)!.definition.questions[0]! };
}

async function restart(context: Awaited<ReturnType<typeof openPlan>>): Promise<Plan> {
	await Service.close(context.plan);
	return Service.open(context.channel.id, context.backend, context.server);
}

function addCriterion(
	plan: Plan,
	context: { server: never },
	id: string,
	key: string,
	label: string,
) {
	let { ws, frames } = member("ana");
	let question = plan.records.get(id)!.definition.questions[0]!.id;
	return Questions.addCriterion(plan, context.server, "test", ws, {
		kind: "question:criterion",
		ts: 0,
		rid: key,
		id,
		question,
		key,
		label,
	}).then(() => frames.find(frame => frame.rid === key) ?? frames[0]);
}

test("asking with criteria records and projects them, and survives a restart", async () => {
	let { context, plan, id, item } = await setup();
	expect(item.criteria).toHaveLength(2);
	expect(item.criteria![0]!.id).toMatch(/^[0-9A-Z]{26}$/);
	let source = room.project(plan.document);
	expect(source).toContain('<Criterion id="');
	expect(source).toContain('label="New device"');

	let reopened = await restart(context);
	try {
		expect(Store.get(reopened.questions, id)!.definition.questions[0]!.criteria)
			.toEqual(item.criteria);
		expect(reopened.records.get(id)!.definition.questions[0]!.criteria).toEqual(item.criteria);
		expect(room.project(reopened.document)).toBe(source);
	} finally {
		await Service.close(reopened);
	}
});

test("a criterion is appended once per key, bounded, and durable before it is announced", async () => {
	let { context, plan, id } = await setup();
	let reply = await addCriterion(plan, context as never, id, "criterion-1", " No new storage ");
	expect(reply).toMatchObject({ ok: true, criterion: { label: "No new storage" } });
	let added = context.broadcasts.find(frame => frame.kind === "question:criterion-added");
	expect(added).toMatchObject({ id, by: "ana", criterion: { label: "No new storage" } });
	expect(room.project(plan.document)).toContain('label="No new storage"');

	let again = await addCriterion(plan, context as never, id, "criterion-1", "No new storage");
	expect(again).toMatchObject({ ok: true, repeated: true, criterion: { label: "No new storage" } });
	expect(plan.records.get(id)!.definition.questions[0]!.criteria).toHaveLength(3);

	expect(await addCriterion(plan, context as never, id, "criterion-2", "easy RESET")).toMatchObject(
		{
			ok: false,
			reason: "duplicate",
		},
	);
	expect(await addCriterion(plan, context as never, id, "criterion-3", "")).toMatchObject({
		ok: false,
		reason: "invalid",
	});
	await addCriterion(plan, context as never, id, "criterion-4", "Fast");
	await addCriterion(plan, context as never, id, "criterion-5", "Cheap");
	expect(await addCriterion(plan, context as never, id, "criterion-6", "One too many"))
		.toMatchObject({
			ok: false,
			reason: "full",
		});

	let reopened = await restart(context);
	try {
		let criteria = plan.records.get(id)!.definition.questions[0]!.criteria;
		expect(Store.get(reopened.questions, id)!.definition.questions[0]!.criteria).toEqual(criteria);
		// The first key still resolves to the same criterion after a restart.
		let { ws, frames } = member("ana");
		await Questions.addCriterion(reopened, context.server, "test", ws, {
			kind: "question:criterion",
			ts: 0,
			rid: "again",
			id,
			question: reopened.records.get(id)!.definition.questions[0]!.id,
			key: "criterion-1",
			label: "No new storage",
		});
		expect(frames[0]).toMatchObject({ ok: true, repeated: true });
	} finally {
		await Service.close(reopened);
	}
});

test("a criterion is refused on a settled or written decision", async () => {
	let context = await openPlan();
	let plan = context.plan;
	try {
		let created = Promise.withResolvers<void>();
		void Questions.ask(
			plan,
			context.server,
			"test",
			Questions.identify({
				questions: [{ header: "h", question: "q", multiple: false, response: "text", options: [] }],
			}),
			undefined,
			created.resolve,
		);
		await created.promise;
		let id = [...plan.records.keys()][0]!;
		expect(await addCriterion(plan, context as never, id, "criterion-1", "Cheap")).toMatchObject({
			ok: false,
			reason: "invalid",
		});
	} finally {
		await Service.close(plan);
	}
});

test("marks are shared draft state, snapshotted on save, and kept through reopen", async () => {
	let { context, plan, id, item } = await setup();
	let [passkeys, passwords] = item.options as [Question.Option, Question.Option];
	let [device, reset] = item.criteria as [Question.Criterion, Question.Criterion];
	let { ws, frames } = member("ana");

	let opened = Store.snapshot(plan.questions, id);
	if (!opened.open) throw new Error("not open");
	let model = Question.restore(opened.model, opened.definition);
	Question.setMark(model, item.id, passkeys.id, device.id, "yes");
	Question.setMark(model, item.id, passwords.id, reset.id, "partly");
	model.api.val([item.id, "choice"]).set(passkeys.id);
	await Questions.edit(plan, ws, {
		kind: "question:edit",
		ts: 0,
		rid: "edit",
		id,
		patch: [...model.api.flush().toBinary()],
	});
	expect(frames.find(frame => frame.rid === "edit")).toMatchObject({
		accepted: true,
		applied: true,
	});

	// A mark for a cell the definition does not describe is rejected without changing the draft.
	let bad = Question.restore(
		[...Store.get(plan.questions, id)!.model.toBinary()],
		opened.definition,
	);
	Question.setMark(bad, item.id, "nope", device.id, "yes");
	await Questions.edit(plan, ws, {
		kind: "question:edit",
		ts: 0,
		rid: "bad",
		id,
		patch: [...bad.api.flush().toBinary()],
	});
	expect(frames.find(frame => frame.rid === "bad")).toMatchObject({ accepted: false });

	// The draft reads back across a restart.
	let restarted = await restart(context);
	let revision = Store.get(restarted.questions, id)!.revision;
	let entry = Store.get(restarted.questions, id)!;
	expect(Question.read(entry.model, entry.definition)[item.id]!.marks).toEqual({
		[Question.markKey(passkeys.id, device.id)]: "yes",
		[Question.markKey(passwords.id, reset.id)]: "partly",
	});

	let saver = member("ana");
	await Questions.submit(restarted, context.server, "test", saver.ws, {
		kind: "question:submit",
		ts: 0,
		rid: "submit",
		id,
		revision,
	});
	expect(saver.frames.find(frame => frame.rid === "submit")).toMatchObject({ ok: true });
	let marks = {
		[Question.markKey(passkeys.id, device.id)]: "yes",
		[Question.markKey(passwords.id, reset.id)]: "partly",
	};
	let record = restarted.records.get(id)!;
	expect(record.status).toBe("answered");
	expect(record.marks).toEqual(marks);
	expect(meta(restarted, record).marks).toEqual(marks);
	let source = room.project(restarted.document);
	expect(source).toContain(`marks="${Question.markKey(passkeys.id, device.id)}:yes`);
	expect(() => normalizeRecord(JSON.parse(JSON.stringify(record)))).not.toThrow();

	// Settled marks load again after another restart.
	let settled = await restart({ ...context, plan: restarted });
	try {
		expect(settled.records.get(id)!.marks).toEqual(marks);
		expect(room.project(settled.document)).toBe(source);

		let reopen = member("ben");
		await Questions.reopen(settled, context.server, "test", reopen.ws, {
			kind: "question:reopen",
			ts: 0,
			rid: "reopen",
			id,
		});
		expect(reopen.frames.find(frame => frame.rid === "reopen")).toMatchObject({ ok: true });
		let again = settled.records.get(id)!;
		expect(again.marks).toBeUndefined();
		expect(again.history[0]!.marks).toEqual(marks);
		expect(meta(settled, again).marks).toBeUndefined();
		expect(meta(settled, again).history[0]!.marks).toEqual(marks);
		expect(room.project(settled.document)).not.toContain("marks=");
		let fresh = Store.get(settled.questions, id)!;
		expect(Question.read(fresh.model, fresh.definition)[item.id]!.marks).toEqual({});
	} finally {
		await Service.close(settled);
	}
});

test("records and drafts stored before criteria load unchanged, and reject bad criteria data", () => {
	let base = {
		id: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
		status: "answered",
		answers: { q: "A" },
		choices: ["o"],
		definition: {
			questions: [{
				id: "q",
				header: "h",
				question: "q",
				multiple: false,
				options: [{ id: "o", label: "A", description: "" }],
			}],
		},
	};
	expect(normalizeRecord(base)).toMatchObject({ id: base.id, history: [] });

	let withCriteria = {
		...base,
		definition: {
			questions: [{
				...base.definition.questions[0]!,
				criteria: [{ id: "c", label: "Cheap" }],
			}],
		},
		marks: { "o/c": "no" },
		history: [{ choices: ["o"], marks: { "o/c": "yes" }, owner: "ana", at: 1 }],
	};
	expect(normalizeRecord(withCriteria).marks).toEqual({ "o/c": "no" });
	for (
		let bad of [
			{ ...withCriteria, marks: { "o/zzz": "no" } },
			{ ...withCriteria, marks: { "zzz/c": "no" } },
			{ ...withCriteria, marks: { "o/c": "maybe" } },
			{ ...base, marks: { "o/c": "no" } },
			{ ...withCriteria, appended: { "key-12345": "nope" } },
			{
				...withCriteria,
				history: [{ choices: ["o"], marks: { "o/c": 1 }, owner: "ana", at: 1 }],
			},
		]
	) expect(() => normalizeRecord(bad)).toThrow();
	expect(normalizeRecord({ ...withCriteria, appended: { "key-12345": "c" } }).appended)
		.toEqual({ "key-12345": "c" });

	// A draft stored before `marks` existed gains an empty object when restored.
	let definition = Question.identified(base.definition);
	let legacy = Question.crdt.Model.create(Question.crdt.schema.obj({
		q: Question.crdt.schema.obj({
			mode: Question.crdt.schema.val(Question.crdt.schema.con("choices")),
			choice: Question.crdt.schema.val(Question.crdt.schema.con(null)),
			options: Question.crdt.schema.obj({}),
			custom: Question.crdt.schema.str(""),
		}),
	}));
	legacy.api.flush();
	let restored = Store.restore([{
		id: "x",
		definition,
		model: [...legacy.toBinary()],
		revision: 2,
	}]);
	let entry = Store.get(restored, "x")!;
	expect(Object.keys((entry.model.view() as { q: object }).q)).toContain("marks");
	expect(Question.read(entry.model, entry.definition).q).not.toHaveProperty("marks");
});
