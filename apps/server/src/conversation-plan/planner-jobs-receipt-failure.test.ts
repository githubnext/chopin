import { describe, expect, test } from "bun:test";
import { type Effect, runEffects } from "./effects";
import { harness } from "./planner-jobs.test-fixtures";

describe("createPlannerJobs", () => {
	test("a failed option receipt blocks its same-thread job until the option replay succeeds", async () => {
		let ran = 0;
		let h = harness(async () => {
			ran++;
			return { status: "done", output: "{}" };
		});
		let receipts = new Set<string>();
		let marked = 0;
		let added: string[] = [];
		let reported: unknown[] = [];
		let effects: Effect[] = [
			{
				key: "job:refine:W1:e1",
				kind: "job",
				threadId: "t1",
				intent: { kind: "refine", target: "W1", trigger: "m1" },
			},
			{
				key: "option:o1",
				kind: "add-option",
				threadId: "t1",
				optionId: "o1",
				label: "GitHub Apps",
				trigger: "m2",
			},
		];
		h.plan.conversationPlanPendingEffects = [effects[0]!];
		let deps = {
			applied: (key: string) => receipts.has(key),
			markApplied: async (key: string) => {
				if (++marked === 1) throw new Error("receipt lost");
				receipts.add(key);
			},
			target: () => ({ kind: "open" as const, id: "W1" }),
			insertCard: async () => "W1",
			link: async () => {},
			addOption: async (_id: string, input: { optionId: string }) => {
				if (!added.includes(input.optionId)) added.push(input.optionId);
			},
			suggest: async () => {},
			prompt: async () => {},
			enqueueJob: h.service.enqueue,
			report: (error: unknown) => reported.push(error),
		};
		expect(await runEffects(deps, effects)).toBe(0);
		expect(added).toEqual(["o1"]);
		await h.service.idle();
		expect(await runEffects(deps, effects)).toBe(2);
		await h.service.idle();
		expect(added).toEqual(["o1"]);
		expect(ran).toBe(1);
		expect(h.service.jobs()).toHaveLength(1);
		expect(reported).toHaveLength(1);
	});
});
