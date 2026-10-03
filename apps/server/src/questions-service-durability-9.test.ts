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
let { definition, asking } = fixture;

// Retained durability scenarios adapted to the keyed shared-option protocol.
test("adding to a card whose authoritative record is closed is refused", async () => {
	let context = await openPlan();
	let plan = context.plan;
	plans.push(plan);
	let asked = asking(plan, context.server, definition());
	await asked.created;
	let id = [...plan.records.keys()][0]!;
	let record = plan.records.get(id)!;
	plan.records.set(id, { ...record, status: "cancelled" });
	let source = room.project(plan.document);
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			frames.push(JSON.parse(raw));
		},
	} as unknown as Socket;

	try {
		await Questions.addOption(plan, context.server, "test", ws, {
			kind: "question:option",
			question: plan.records.get(id)!.definition.questions[0]!.id,
			key: "add-option-1",
			ts: 0,
			rid: "closed",
			id,
			label: "GitHub Apps",
		});

		expect(frames).toMatchObject([{ ok: false, reason: "resolved", rid: "closed" }]);
		expect(Store.get(plan.questions, id)?.definition.questions[0].options).toHaveLength(1);
		expect(plan.records.get(id)?.definition.questions[0].options).toHaveLength(1);
		expect(room.project(plan.document)).toBe(source);
		let stored = await context.storage.collaboration.load(context.channel.id, context.now);
		expect(JSON.stringify(stored?.sidecar)).not.toContain("GitHub Apps");
	} finally {
		plan.records.set(id, record);
	}
});

test("non-string, empty and overlong option labels are refused without a mutation", async () => {
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
	let invalid = [
		123,
		["Nested"],
		{ text: "Object" },
		"   ",
		"x".repeat(Question.limits.MAX_LABEL + 1),
	];
	for (let [index, label] of invalid.entries()) {
		await Questions.addOption(plan, context.server, "test", ws, {
			kind: "question:option",
			question: plan.records.get(id)!.definition.questions[0]!.id,
			key: "add-option-2",
			ts: 0,
			rid: `invalid-${index}`,
			id,
			label: label as unknown as string,
		});
	}

	expect(frames).toHaveLength(invalid.length);
	for (let frame of frames) expect(frame).toMatchObject({ ok: false, reason: "invalid" });
	expect(Store.get(plan.questions, id)?.definition.questions[0].options).toHaveLength(1);
	expect(plan.records.get(id)?.definition.questions[0].options).toHaveLength(1);
	expect(context.broadcasts.filter(frame => frame.kind === "question:option-added")).toHaveLength(
		0,
	);
});
