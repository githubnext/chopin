import { expect, test } from "bun:test";
import * as Question from "@chopin/question";

import * as Questions from "./questions/service";
import * as Store from "./questions/store";
import * as room from "./plan/room";

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

// Retained durability scenarios adapted to the keyed shared-option protocol.
test("adding an option changes the record, document, and durable state before publication", async () => {
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
	let original = context.storage.collaboration.commit;
	let release = Promise.withResolvers<void>();
	(context.storage.collaboration as { commit: typeof original }).commit = async input => {
		await release.promise;
		return original(input);
	};
	let oldSource = room.project(plan.document);
	let oldRevision = plan.revision;
	let opened = Store.snapshot(plan.questions, id);
	if (!opened.open) throw new Error("question was not open");
	let item = opened.definition.questions[0];
	let model = Question.crdt.Model.fromBinary(new Uint8Array(opened.model))
		.fork() as unknown as Question.Model;
	model.api.val([item.id, "choice"]).set(item.options[0]!.id);
	let patch = model.api.flush();
	if (!patch) throw new Error("selection produced no patch");
	let pending = Questions.addOption(plan, context.server, "test", ws, {
		kind: "question:option",
		question: plan.records.get(id)!.definition.questions[0]!.id,
		key: "add-option-1",
		ts: 0,
		rid: "add",
		id,
		label: "GitHub Apps",
	});
	await Bun.sleep(20);
	let editing = Questions.edit(plan, ws, {
		kind: "question:edit",
		ts: 0,
		rid: "select",
		id,
		patch: [...patch.toBinary()],
	});
	await Bun.sleep(10);
	try {
		expect(frames).toHaveLength(0);
		expect(context.broadcasts.filter(frame => frame.kind === "question:option-added")).toHaveLength(
			0,
		);
		expect(room.project(plan.document)).toBe(oldSource);
		expect(Store.get(plan.questions, id)?.definition.questions[0].options).toHaveLength(1);
		expect(plan.revision).toBe(oldRevision);
	} finally {
		release.resolve();
	}
	await Promise.all([pending, editing]);
	(context.storage.collaboration as { commit: typeof original }).commit = original;

	let response = frames.find(frame => frame.kind === "question:option");
	let changed = context.broadcasts.find(frame => frame.kind === "question:option-added");
	let update = context.broadcasts.findLast(frame => frame.kind === "plan:update");
	let options = Store.get(plan.questions, id)!.definition.questions[0].options;
	expect(response).toMatchObject({ ok: true, option: { label: "GitHub Apps" } });
	expect(frames.find(frame => frame.rid === "select")).toMatchObject({
		open: true,
		accepted: true,
		applied: true,
		revision: 1,
	});
	expect(changed).toMatchObject({ id, option: { label: "GitHub Apps" } });
	expect(update).toBeDefined();
	expect(options.map(option => option.label)).toEqual(["Choose this", "GitHub Apps"]);
	expect(plan.records.get(id)?.definition.questions[0].options).toEqual(options);
	expect(
		Question.read(
			Store.get(plan.questions, id)!.model,
			Store.get(plan.questions, id)!.definition,
		)[item.id]!.choice,
	).toBe(item.options[0]!.id);
	let liveSource = room.project(plan.document);
	expect(liveSource).toContain('label="GitHub Apps"');
	let reopened = await restart(context);
	expect(Store.get(reopened.questions, id)?.definition.questions[0].options).toEqual(options);
	expect(
		Question.read(
			Store.get(reopened.questions, id)!.model,
			Store.get(reopened.questions, id)!.definition,
		)[item.id]!.choice,
	).toBe(item.options[0]!.id);
	expect(room.project(reopened.document)).toBe(liveSource);
});

test("two competing adds with the same label commit one option", async () => {
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
	} as unknown as Socket;

	await Promise.all([
		Questions.addOption(plan, context.server, "test", ws, {
			kind: "question:option",
			question: plan.records.get(id)!.definition.questions[0]!.id,
			key: "add-option-2",
			ts: 0,
			rid: "first",
			id,
			label: "GitHub Apps",
		}),
		Questions.addOption(plan, context.server, "test", ws, {
			kind: "question:option",
			question: plan.records.get(id)!.definition.questions[0]!.id,
			key: "add-option-3",
			ts: 0,
			rid: "second",
			id,
			label: "github apps",
		}),
	]);

	let options = Store.get(plan.questions, id)!.definition.questions[0].options;
	expect(frames.find(frame => frame.rid === "first")).toMatchObject({ ok: true });
	expect(frames.find(frame => frame.rid === "second")).toMatchObject({
		ok: false,
		reason: "duplicate",
	});
	expect(options.map(option => option.label)).toEqual(["Choose this", "GitHub Apps"]);
	expect(Store.get(plan.questions, id)?.revision).toBe(0);
	expect(context.broadcasts.filter(frame => frame.kind === "question:option-added")).toHaveLength(
		1,
	);
	let reopened = await restart(context);
	expect(Store.get(reopened.questions, id)?.definition.questions[0].options).toEqual(options);
});
