import { expect, test } from "bun:test";

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

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
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
			kind: "question:add-option",
			ts: 0,
			rid: "closed",
			id,
			label: "GitHub Apps",
		});

		expect(frames).toMatchObject([{ ok: false, reason: "closed", rid: "closed" }]);
		expect(Store.get(plan.questions, id)?.definition.questions[0].options).toHaveLength(1);
		expect(plan.records.get(id)?.definition.questions[0].options).toHaveLength(1);
		expect(room.project(plan.document)).toBe(source);
		let stored = await context.storage.collaboration.load(context.channel.id, context.now);
		expect(JSON.stringify(stored?.sidecar)).not.toContain("GitHub Apps");
	} finally {
		plan.records.set(id, record);
	}
});

test("non-string option labels are invalid instead of coerced into text", async () => {
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
	for (let [index, label] of [123, ["Nested"], { text: "Object" }].entries()) {
		await Questions.addOption(plan, context.server, "test", ws, {
			kind: "question:add-option",
			ts: 0,
			rid: `invalid-${index}`,
			id,
			label: label as unknown as string,
		});
	}

	expect(frames).toHaveLength(3);
	for (let frame of frames) expect(frame).toMatchObject({ ok: false, reason: "invalid" });
	expect(Store.get(plan.questions, id)?.definition.questions[0].options).toHaveLength(1);
	expect(plan.records.get(id)?.definition.questions[0].options).toHaveLength(1);
	expect(context.broadcasts.filter(frame => frame.kind === "question:changed")).toHaveLength(0);
});
