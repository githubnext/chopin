import { expect, test } from "bun:test";
import * as Question from "@chopin/question";

import * as Questions from "./questions/service";
import * as Store from "./questions/store";
import * as room from "./plan/room";
import * as Service from "./plan/service";

import { openPlan } from "./testing/plan";

import type { Plan } from "./plan/service";
import type { Socket } from "./wire";
import { createQuestionServiceFixture } from "./question-service.test-fixtures";

let plans: Plan[];
let fixture = createQuestionServiceFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { restart, definition, asking } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
test("a failed option commit leaves the live and durable card at their prior shape", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			frames.push(JSON.parse(raw));
		},
		publish(_topic: string, raw: string) {
			frames.push(JSON.parse(raw));
		},
	} as unknown as Socket;
	let source = room.project(plan.document);
	let revision = plan.revision;
	let broadcasts = context.broadcasts.length;
	let opened = Store.snapshot(plan.questions, id);
	if (!opened.open) throw new Error("question was not open");
	let item = opened.definition.questions[0];
	let model = Question.crdt.Model.fromBinary(new Uint8Array(opened.model))
		.fork() as unknown as Question.Model;
	model.api.val([item.id, "choice"]).set(item.options[0]!.id);
	let patch = model.api.flush();
	if (!patch) throw new Error("selection produced no patch");
	let original = context.storage.collaboration.commit;
	let release = Promise.withResolvers<void>();
	let commits = 0;
	(context.storage.collaboration as { commit: typeof original }).commit = async input => {
		if (++commits === 1) {
			await release.promise;
			throw new Error("storage unavailable");
		}
		return original(input);
	};
	try {
		let adding = Questions.addOption(plan, context.server, "test", ws, {
			kind: "question:add-option",
			ts: 0,
			rid: "failed",
			id,
			label: "GitHub Apps",
		});
		await Bun.sleep(20);
		let editing = Questions.edit(plan, ws, {
			kind: "question:edit",
			ts: 0,
			rid: "select-after-failure",
			id,
			patch: [...patch.toBinary()],
		});
		await Bun.sleep(10);
		expect(frames).toHaveLength(0);
		release.resolve();
		await Promise.all([adding, editing]);
	} finally {
		release.resolve();
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}

	expect(frames.find(frame => frame.rid === "failed")).toMatchObject({ kind: "session:error" });
	expect(frames.find(frame => frame.rid === "select-after-failure")).toMatchObject({
		open: true,
		accepted: true,
		applied: true,
	});
	expect(context.broadcasts.slice(broadcasts).map(frame => frame.kind)).toEqual(["question:meta"]);
	expect(plan.revision).toBe(revision);
	expect(room.project(plan.document)).toBe(source);
	expect(Store.get(plan.questions, id)?.definition.questions[0].options).toHaveLength(1);
	expect(
		Question.read(
			Store.get(plan.questions, id)!.model,
			Store.get(plan.questions, id)!.definition,
		)[item.id]!.choice,
	).toBe(item.options[0]!.id);
	expect(plan.records.get(id)?.definition.questions[0].options).toHaveLength(1);
	let reopened = await restart(context);
	expect(room.project(reopened.document)).toBe(source);
	expect(Store.get(reopened.questions, id)?.definition.questions[0].options).toHaveLength(1);
	expect(
		Question.read(
			Store.get(reopened.questions, id)!.model,
			Store.get(reopened.questions, id)!.definition,
		)[item.id]!.choice,
	).toBe(item.options[0]!.id);
	await Questions.addOption(reopened, context.server, "test", ws, {
		kind: "question:add-option",
		ts: 0,
		rid: "retry",
		id,
		label: "GitHub Apps",
	});
	expect(frames.find(frame => frame.rid === "retry")).toMatchObject({ ok: true });
	expect(Store.get(reopened.questions, id)?.definition.questions[0].options).toHaveLength(2);
});

test("a failed draft commit leaves the selection unacknowledged and unchanged", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let opened = Store.snapshot(plan.questions, id);
	if (!opened.open) throw new Error("question was not open");
	let item = opened.definition.questions[0];
	let model = Question.crdt.Model.fromBinary(new Uint8Array(opened.model))
		.fork() as unknown as Question.Model;
	model.api.val([item.id, "choice"]).set(item.options[0]!.id);
	let patch = model.api.flush();
	if (!patch) throw new Error("selection produced no patch");
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			frames.push(JSON.parse(raw));
		},
	} as unknown as Socket;
	let original = context.storage.collaboration.commit;
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		throw new Error("storage unavailable");
	};
	try {
		await Questions.edit(plan, ws, {
			kind: "question:edit",
			ts: 0,
			rid: "edit-failed",
			id,
			patch: [...patch.toBinary()],
		});
	} finally {
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}

	expect(frames).toMatchObject([{ kind: "session:error", rid: "edit-failed" }]);
	expect(Store.get(plan.questions, id)?.revision).toBe(0);
	expect(
		Question.read(
			Store.get(plan.questions, id)!.model,
			Store.get(plan.questions, id)!.definition,
		)[item.id]!.choice,
	).toBeNull();
	let reopened = await restart(context);
	expect(Store.get(reopened.questions, id)?.revision).toBe(0);
	expect(
		Question.read(
			Store.get(reopened.questions, id)!.model,
			Store.get(reopened.questions, id)!.definition,
		)[item.id]!.choice,
	).toBeNull();
});

test("adding to a card removed from the document leaves its record and draft unchanged", async () => {
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
	let source = room.project(plan.document);
	let revision = Store.get(plan.questions, id)!.revision;
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			frames.push(JSON.parse(raw));
		},
	} as unknown as Socket;

	await Questions.addOption(plan, context.server, "test", ws, {
		kind: "question:add-option",
		ts: 0,
		rid: "missing",
		id,
		label: "GitHub Apps",
	});

	expect(frames).toMatchObject([{ ok: false, reason: "closed", rid: "missing" }]);
	expect(Store.get(plan.questions, id)?.revision).toBe(revision);
	expect(Store.get(plan.questions, id)?.definition.questions[0].options).toHaveLength(1);
	expect(plan.records.get(id)?.definition.questions[0].options).toHaveLength(1);
	expect(room.project(plan.document)).toBe(source);
	let reopened = await restart(context);
	expect(Store.get(reopened.questions, id)?.definition.questions[0].options).toHaveLength(1);
	expect(room.project(reopened.document)).toBe(source);
});
