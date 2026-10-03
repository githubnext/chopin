import { expect, test } from "bun:test";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import { createDecisionProseFixture } from "./decision-prose.test-fixtures";

let contexts: ReturnType<typeof createDecisionProseFixture>["contexts"];
let fixture = createDecisionProseFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { CARD, WIDGET, opened, job, proseTool, input } = fixture;

test("write_decision_prose commits one staged insert and publishes anchors and metadata afterward", async () => {
	let context = await opened();
	job(context);
	let tool = proseTool(context);
	let before = room.project(context.plan.document);
	let response = await tool.handler(input(context), {} as never);
	expect(JSON.parse(String(response))).toEqual({
		ok: true,
		title: "Which authentication approach?",
		mode: "insert",
		revision: 1,
	});
	expect(room.project(context.plan.document)).toBe(
		before.replace("Context.\n\n", "Context.\n\nWe chose GitHub Apps.\n\n"),
	);
	expect(context.plan.document.seq).toBe(1);
	expect(context.broadcasts.filter(frame => frame.kind === "plan:update")).toHaveLength(1);
	expect(context.broadcasts.filter(frame => frame.kind === "plan:anchors")).toHaveLength(1);
	expect(context.broadcasts.filter(frame => frame.kind === "question:meta")).toHaveLength(1);
	expect(tool.anchors()).toBe(1);
	expect(tool.changes()).toBe(1);
	expect(Questions.prose(context.plan)[0]).toMatchObject({ widget: CARD, orphaned: false });
	expect(room.matchesAnchor(context.plan.document, context.plan.records.get(CARD)!.prose![0]!, 1))
		.toBe(true);
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	expect((await Service.readStored(loaded)).source).toBe(room.project(context.plan.document));
});

test("write_decision_prose uses one durable delta for a first-card two-step insertion", async () => {
	let context = await opened(WIDGET);
	job(context);
	let before = room.project(context.plan.document);
	let result = await proseTool(context).handler(input(context), {} as never);
	expect(JSON.parse(String(result)).ok).toBe(true);
	expect(room.project(context.plan.document)).toBe(`We chose GitHub Apps.\n\n${before}`);
	expect(context.plan.document.seq).toBe(1);
	expect(context.broadcasts.filter(frame => frame.kind === "plan:update")).toHaveLength(1);
	expect(room.matchesAnchor(context.plan.document, context.plan.records.get(CARD)!.prose![0]!, 0))
		.toBe(true);
});
