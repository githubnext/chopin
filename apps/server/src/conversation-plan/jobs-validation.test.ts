import { describe, expect, test } from "bun:test";

import * as Jobs from "./jobs";
import { AT, card } from "./jobs.test-fixtures";

describe("Planner job queue", () => {
	test("queue transitions reject data that could not be restored", () => {
		let jobs = Jobs.enqueue([], card("m1"), AT);
		expect(() =>
			Jobs.enqueue(jobs, {
				kind: "heading",
				target: "wrong",
				trigger: "m2",
			}, AT)
		).toThrow("invalid Planner job");
		expect(() =>
			Jobs.enqueue(jobs, {
				kind: "refine",
				target: "x".repeat(201),
				trigger: "m2",
			}, AT)
		).toThrow("invalid Planner job");
		expect(() =>
			Jobs.enqueue(jobs, {
				kind: "refine",
				target: "W2",
				trigger: "x".repeat(201),
			}, AT)
		).toThrow("invalid Planner job");
		expect(() => Jobs.enqueue(jobs, card("m2"), "yesterday")).toThrow("invalid Planner job");
		expect(() => Jobs.start(jobs, "refine:W1:m1", "yesterday"))
			.toThrow("invalid Planner job");
		let running = Jobs.start(jobs, "refine:W1:m1", AT);
		expect(() =>
			Jobs.settle(running, "refine:W1:m1", {
				status: "done",
				output: "not JSON",
			}, AT)
		).toThrow("invalid Planner job");
		expect(() =>
			Jobs.settle(running, "refine:W1:m1", {
				status: "done",
				output: JSON.stringify("x".repeat(4096)),
			}, AT)
		).toThrow("invalid Planner job");
		expect(() =>
			Jobs.settle(running, "refine:W1:m1", {
				status: "failed",
				reason: "x".repeat(501),
			}, AT)
		).toThrow("invalid Planner job");
		let failed = Jobs.settle(running, "refine:W1:m1", {
			status: "failed",
			reason: "temporarily unavailable",
		}, AT);
		expect(() => Jobs.retry(failed, "refine:W1:m1", "yesterday"))
			.toThrow("invalid Planner job");
		expect(jobs[0]?.status).toBe("pending");
		expect(running[0]?.status).toBe("running");
	});

	test("retry waits while newer card work for the same target is pending", () => {
		let failed = Jobs.settle(
			Jobs.start(Jobs.enqueue([], card("m1"), AT), "refine:W1:m1", AT),
			"refine:W1:m1",
			{ status: "failed", reason: "Planner unavailable" },
			AT,
		);
		let jobs = Jobs.enqueue(failed, card("m2", "suggest"), AT);
		expect(Jobs.retry(jobs, "refine:W1:m1", AT)).toBe(jobs);
		let after = Jobs.settle(Jobs.start(jobs, "suggest:W1:m2", AT), "suggest:W1:m2", {
			status: "done",
			output: "{}",
		}, AT);
		expect(Jobs.retry(after, "refine:W1:m1", AT)[0]?.status).toBe("pending");
	});

	test("card targets cannot make two intents share a colon-delimited job ID", () => {
		let valid = { kind: "refine" as const, target: "W1", trigger: "m2:m3" };
		let ambiguous = { kind: "refine" as const, target: "W1:m2", trigger: "m3" };
		expect(Jobs.jobId(valid)).toBe("refine:W1:m2:m3");
		expect(() => Jobs.jobId(ambiguous)).toThrow("invalid Planner job");
		expect(() => Jobs.enqueue([], ambiguous, AT)).toThrow("invalid Planner job");
		let raw = {
			...Jobs.enqueue([], valid, AT)[0]!,
			target: ambiguous.target,
			trigger: ambiguous.trigger,
		};
		expect(() => Jobs.restore([raw])).toThrow("invalid Planner job");
	});
});
