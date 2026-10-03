import { expect, spyOn, test } from "bun:test";
import { $getRoot } from "lexical";
import * as room from "../plan/room";
import { createDecisionProseFixture } from "./decision-prose.test-fixtures";

let contexts: ReturnType<typeof createDecisionProseFixture>["contexts"];
let fixture = createDecisionProseFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { CARD, WIDGET, opened, job, proseTool, input } = fixture;

test("write_decision_prose replaces uniquely moved prose at its new position", async () => {
	let context = await opened(`Other context.\n\nOld decision prose.\n\n${WIDGET}`);
	context.plan.records.get(CARD)!.prose = [
		room.anchorAt(context.plan.document, 1, room.digests(context.plan.document)[1]!),
	];
	context.plan.document.editor.update(() => {
		let children = $getRoot().getChildren();
		children[0]!.insertBefore(children[1]!);
	}, { discrete: true });
	await room.settle();
	job(context);
	let result = await proseTool(context).handler(input(context, "New prose."), {} as never);
	expect(JSON.parse(String(result)).mode).toBe("replace");
	expect(room.project(context.plan.document)).toStartWith("New prose.\n\nOther context.\n\n");
});

test("write_decision_prose rejects missing or stale job generation and invalid text", async () => {
	let context = await opened();
	let tool = proseTool(context);
	let before = room.project(context.plan.document);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(String(await tool.handler(input(context), {} as never)))
			.toContain("only available to a background Planner job");
		job(context, 2);
		expect(String(await tool.handler(input(context), {} as never))).toContain("generation");
		job(context);
		for (let text of ["# Heading", "One.\n\nTwo.", "Text <Badge />"]) {
			expect(String(await tool.handler(input(context, text), {} as never))).toStartWith("Error:");
		}
		expect(room.project(context.plan.document)).toBe(before);
		expect(context.plan.chat.jobOutput).toBeUndefined();
	} finally {
		errors.mockRestore();
	}
});
