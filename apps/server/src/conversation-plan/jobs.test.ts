import { describe, expect, test } from "bun:test";

import * as Jobs from "./jobs";
import { AT, card } from "./jobs.test-fixtures";

describe("Planner job queue", () => {
	test("a trigger mints one stable pending job", () => {
		let once = Jobs.enqueue([], card("m1"), AT);
		expect(once).toEqual([{
			id: "refine:W1:m1",
			kind: "refine",
			target: "W1",
			trigger: "m1",
			status: "pending",
			attempts: 0,
			at: AT,
		}]);
		expect(Jobs.enqueue(once, card("m1"), AT)).toBe(once);
	});

	test("pending card work coalesces, with refine taking the pending place", () => {
		let jobs = Jobs.enqueue([], { kind: "heading", target: "document", trigger: "m0" }, AT);
		jobs = Jobs.enqueue(jobs, card("m1", "suggest"), AT);
		expect(Jobs.enqueue(jobs, card("m2", "suggest"), AT)).toBe(jobs);
		jobs = Jobs.enqueue(jobs, card("m3", "refine"), AT);
		expect(jobs.map(job => job.id)).toEqual([
			"heading:document:m0",
			"refine:W1:m3",
		]);
		expect(Jobs.enqueue(jobs, card("m4", "suggest"), AT)).toBe(jobs);
		expect(Jobs.enqueue(jobs, card("m5", "refine"), AT)).toBe(jobs);
	});

	test("only the first pending job starts, and running work keeps later work queued", () => {
		let jobs = Jobs.enqueue([], card("m1"), AT);
		jobs = Jobs.enqueue(jobs, { kind: "suggest", target: "W2", trigger: "m2" }, AT);
		expect(Jobs.next(jobs)?.id).toBe("refine:W1:m1");
		expect(Jobs.start(jobs, "suggest:W2:m2", AT)).toBe(jobs);
		jobs = Jobs.start(jobs, "refine:W1:m1", AT);
		expect(Jobs.next(jobs)).toBeUndefined();
		expect(Jobs.start(jobs, "suggest:W2:m2", AT)).toBe(jobs);
		let queued = Jobs.enqueue(jobs, card("m3", "suggest"), AT);
		expect(queued.map(job => [job.id, job.status])).toEqual([
			["refine:W1:m1", "running"],
			["suggest:W2:m2", "pending"],
			["suggest:W1:m3", "pending"],
		]);
		let done = Jobs.settle(queued, "refine:W1:m1", { status: "done", output: "{}" }, AT);
		expect(done[0]).toMatchObject({ status: "done", attempts: 1, output: "{}" });
		expect(Jobs.next(done)?.id).toBe("suggest:W2:m2");
	});

	test("full unfinished queue rejects new work but evicts the oldest done job", () => {
		let jobs: Jobs.Job[] = [];
		for (let index = 0; index < Jobs.MAX_JOBS; index++) {
			jobs = Jobs.enqueue(jobs, {
				kind: "suggest",
				target: `W${index}`,
				trigger: "m",
			}, AT);
		}
		let same = Jobs.enqueue(jobs, { kind: "suggest", target: "W1", trigger: "new" }, AT);
		expect(same).toBe(jobs);
		let late = { kind: "refine" as const, target: "W129", trigger: "late" };
		expect(() => Jobs.enqueue(jobs, late, AT)).toThrow("Planner job queue is full");
		expect(jobs).toHaveLength(Jobs.MAX_JOBS);
		jobs = Jobs.settle(Jobs.start(jobs, "suggest:W0:m", AT), "suggest:W0:m", {
			status: "done",
			output: "{}",
		}, AT);
		let grown = Jobs.enqueue(jobs, late, AT);
		expect(grown).toHaveLength(Jobs.MAX_JOBS);
		expect(grown.some(job => job.id === "suggest:W0:m")).toBe(false);
		expect(grown.at(-1)?.id).toBe("refine:W129:late");
	});

	test("only failed work can be retried, without forgetting its attempt", () => {
		let jobs = Jobs.enqueue([], card("m1"), AT);
		expect(Jobs.retry(jobs, "refine:W1:m1", AT)).toBe(jobs);
		jobs = Jobs.start(jobs, "refine:W1:m1", AT);
		expect(Jobs.retry(jobs, "refine:W1:m1", AT)).toBe(jobs);
		jobs = Jobs.settle(jobs, "refine:W1:m1", {
			status: "failed",
			reason: "Planner unavailable",
		}, AT);
		expect(jobs[0]).toMatchObject({ status: "failed", reason: "Planner unavailable", attempts: 1 });
		expect(Jobs.next(jobs)).toBeUndefined();
		let retried = Jobs.retry(jobs, "refine:W1:m1", AT);
		expect(retried[0]).toMatchObject({ status: "pending", attempts: 1 });
		expect(retried[0]?.reason).toBeUndefined();
		expect(Jobs.retry(retried, "refine:W1:m1", AT)).toBe(retried);
		let skipped = Jobs.settle(Jobs.start(retried, "refine:W1:m1", AT), "refine:W1:m1", {
			status: "skipped",
			reason: "AGENT=off",
		}, AT);
		expect(skipped[0]).toMatchObject({ status: "skipped", attempts: 2 });
		expect(Jobs.retry(skipped, "refine:W1:m1", AT)).toBe(skipped);
	});

	test("refining and message diagnostics show only their matching work", () => {
		let jobs = Jobs.enqueue([], card("m1", "suggest"), AT);
		expect(Jobs.refining(jobs, "W1")).toBe(false);
		jobs = Jobs.enqueue(jobs, { kind: "refine", target: "W2", trigger: "m2" }, AT);
		expect(Jobs.refining(jobs, "W2")).toBe(true);
		expect(Jobs.forTrigger(jobs, "m2").map(job => job.id)).toEqual(["refine:W2:m2"]);
		expect(Jobs.forTrigger(jobs, "m3")).toEqual([]);
		jobs = Jobs.settle(Jobs.start(jobs, "suggest:W1:m1", AT), "suggest:W1:m1", {
			status: "done",
			output: "{}",
		}, AT);
		jobs = Jobs.settle(Jobs.start(jobs, "refine:W2:m2", AT), "refine:W2:m2", {
			status: "done",
			output: "{}",
		}, AT);
		expect(Jobs.refining(jobs, "W2")).toBe(false);
		expect(Jobs.forTrigger(jobs, "m2")).toHaveLength(1);
	});
});
