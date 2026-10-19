import { expect, test } from "bun:test";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { ask } from "./service-ask";
import { identify } from "./service-definition";
import { capture, createDecision } from "./service-capture";

let input = { key: "onboarding-1", question: "How should onboarding work?" };
let sample = identify({
	questions: [{
		header: "Storage",
		question: "Where should state live?",
		multiple: false,
		options: [{ label: "Disk", description: "d" }, { label: "SQL", description: "s" }],
	}],
});

test("a question page is recognised durably and refuses every way of adding a decision", async () => {
	let context = await openPlan("", { parent: "Root", questionPage: { recordId: "R1" } });
	try {
		expect(Plan.isQuestionPage(context.plan)).toBe(true);
		let { plan, server } = context;
		// Planner open_decision and a human New decision share capture().
		await expect(capture(plan, server, plan.id, input, { human: "ana" }))
			.rejects.toThrow(Plan.QUESTION_PAGE_REFUSAL);
		await expect(capture(plan, server, plan.id, input, { revision: plan.revision }))
			.rejects.toThrow(Plan.QUESTION_PAGE_REFUSAL);
		// Planner ask and the dev sample use ask().
		await expect(ask(plan, server, plan.id, sample)).rejects.toThrow(Plan.QUESTION_PAGE_REFUSAL);
		// The wire request gets the existing "invalid" refusal shape.
		let replies: unknown[] = [];
		let ws = { data: { handle: "ana" }, send: (text: string) => replies.push(JSON.parse(text)) };
		await createDecision(plan, server, plan.id, ws as never, { rid: 1, ...input } as never);
		expect(JSON.stringify(replies)).toContain(Plan.QUESTION_PAGE_REFUSAL);
		expect(plan.records.size).toBe(0);
		// The marker survives a restart.
		await Plan.close(plan);
		context.plan = await Plan.open(plan.id, context.backend, server);
		expect(Plan.isQuestionPage(context.plan)).toBe(true);
	} finally {
		await Plan.close(context.plan);
	}
});

test("an ordinary child document still takes decisions", async () => {
	let context = await openPlan("", { parent: "Root" });
	try {
		expect(Plan.isQuestionPage(context.plan)).toBe(false);
		let id = await capture(context.plan, context.server, context.plan.id, input, {
			human: "ana",
		});
		expect(context.plan.records.has(id)).toBe(true);
	} finally {
		await Plan.close(context.plan);
	}
});

test("a malformed question page marker fails restore", async () => {
	await expect(openPlan("", { parent: "Root", questionPage: { recordId: "" } })).rejects.toThrow(
		"question page marker",
	);
});
