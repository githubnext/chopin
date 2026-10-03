import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import type { ConversationPlan } from "@chopin/protocol";
import { createDecisionProseFixture } from "./decision-prose.test-fixtures";

let contexts: ReturnType<typeof createDecisionProseFixture>["contexts"];
let fixture = createDecisionProseFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { CARD, OPTION, opened, job, proseTool, input } = fixture;

test("write_decision_prose fences a replaced job after an awaited staging read", async () => {
	let context = await opened();
	job(context);
	let before = room.project(context.plan.document);
	let original = room.restore;
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let held = spyOn(room, "restore").mockImplementation(async (...args) => {
		entered.resolve();
		await release.promise;
		return original(...args);
	});
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		let action = proseTool(context).handler(input(context), {} as never);
		await entered.promise;
		context.plan.chat.job = { ...context.plan.chat.job!, id: "newer" } as ConversationPlan.Job;
		release.resolve();
		expect(String(await action)).toContain("background Planner job changed");
		expect(room.project(context.plan.document)).toBe(before);
		expect(context.plan.document.seq).toBe(0);
		expect(context.plan.chat.jobOutput).toBeUndefined();
	} finally {
		errors.mockRestore();
		held.mockRestore();
	}
});

test("write_decision_prose fences a newer saved decision after an awaited staging read", async () => {
	let context = await opened();
	job(context);
	let before = room.project(context.plan.document);
	let original = room.restore;
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let held = spyOn(room, "restore").mockImplementation(async (...args) => {
		entered.resolve();
		await release.promise;
		return original(...args);
	});
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		let action = proseTool(context).handler(input(context), {} as never);
		await entered.promise;
		let record = context.plan.records.get(CARD)!;
		context.plan.records.set(CARD, {
			...record,
			history: [{ choices: [OPTION], owner: "mina", at: 1_758_645_000 }],
		});
		release.resolve();
		expect(String(await action)).toContain("background Planner job changed");
		expect(room.project(context.plan.document)).toBe(before);
		expect(context.plan.chat.jobOutput).toBeUndefined();
	} finally {
		errors.mockRestore();
		held.mockRestore();
	}
});
