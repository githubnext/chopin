import { describe, expect, test } from "bun:test";

import * as Jobs from "./jobs";
import { AT, card } from "./jobs.test-fixtures";

describe("Planner job queue", () => {
	test("restore converts an interrupted running job to a failed, non-replayed job", () => {
		let running = Jobs.start(Jobs.enqueue([], card("m1"), AT), "refine:W1:m1", AT);
		let restored = Jobs.restore(JSON.parse(JSON.stringify(running)));
		expect(restored[0]).toEqual({
			id: "refine:W1:m1",
			kind: "refine",
			target: "W1",
			trigger: "m1",
			status: "failed",
			attempts: 0,
			reason: "interrupted",
			at: AT,
		});
		expect(Jobs.next(restored)).toBeUndefined();
		expect(Jobs.restore(undefined)).toEqual([]);
	});

	test("restore rejects malformed structure, identity, bounds, and duplicate work", () => {
		let pending = Jobs.enqueue([], card("m1"), AT)[0]!;
		let cases: Array<[string, unknown]> = [
			["null", null],
			["not an array", {}],
			[
				"over capacity",
				Array.from({ length: Jobs.MAX_JOBS + 1 }, (_, index) => ({
					...pending,
					id: `refine:W${index}:m1`,
					target: `W${index}`,
				})),
			],
			["missing field", [{ id: pending.id }]],
			["unknown field", [{ ...pending, extra: true }]],
			["wrong kind", [{ ...pending, kind: "other" }]],
			["wrong id", [{ ...pending, id: "refine:W1:other" }]],
			["blank target", [{ ...pending, target: " " }]],
			["long target", [{ ...pending, target: "x".repeat(201) }]],
			["blank trigger", [{ ...pending, trigger: " " }]],
			["long trigger", [{ ...pending, trigger: "x".repeat(201) }]],
			["bad timestamp", [{ ...pending, at: "tomorrow" }]],
			["noncanonical timestamp", [{ ...pending, at: "2026-09-25T10:00:00Z" }]],
			["negative attempts", [{ ...pending, attempts: -1 }]],
			["fractional attempts", [{ ...pending, attempts: 1.5 }]],
			["duplicate ids", [pending, { ...pending }]],
		];
		for (let [name, value] of cases) {
			expect(() => Jobs.restore(value), name).toThrow("invalid Planner job");
		}
	});

	test("restore rejects impossible status details and concurrent runners", () => {
		let pending = Jobs.enqueue([], card("m1"), AT)[0]!;
		let running = Jobs.start([pending], pending.id, AT)[0]!;
		let done = Jobs.settle([running], running.id, { status: "done", output: "{}" }, AT)[0]!;
		let failed = Jobs.settle([running], running.id, {
			status: "failed",
			reason: "Planner unavailable",
		}, AT)[0]!;
		let skipped = Jobs.settle([running], running.id, {
			status: "skipped",
			reason: "AGENT=off",
		}, AT)[0]!;
		let cases: Array<[string, unknown]> = [
			["pending reason", [{ ...pending, reason: "old" }]],
			["running output", [{ ...running, output: "{}" }]],
			["done missing output", [{ ...done, output: undefined }]],
			["done malformed JSON", [{ ...done, output: "not JSON" }]],
			["done huge output", [{ ...done, output: JSON.stringify("x".repeat(4096)) }]],
			["done reason", [{ ...done, reason: "old" }]],
			["done without attempt", [{ ...done, attempts: 0 }]],
			["failed missing reason", [{ ...failed, reason: undefined }]],
			["failed huge reason", [{ ...failed, reason: "x".repeat(501) }]],
			["failed output", [{ ...failed, output: "{}" }]],
			["failed without attempt", [{ ...failed, attempts: 0 }]],
			["skipped without attempt", [{ ...skipped, attempts: 0 }]],
			["two running", [running, { ...running, id: "refine:W2:m2", target: "W2", trigger: "m2" }]],
			["two pending card jobs", [pending, {
				...pending,
				id: "suggest:W1:m2",
				kind: "suggest",
				trigger: "m2",
			}]],
		];
		for (let [name, value] of cases) {
			expect(() => Jobs.restore(value), name).toThrow("invalid Planner job");
		}
		expect(
			Jobs.restore([
				done,
				{ ...failed, id: "refine:W2:m2", target: "W2", trigger: "m2" },
				{ ...skipped, id: "refine:W3:m3", target: "W3", trigger: "m3" },
			]).map(job => job.status),
		).toEqual([
			"done",
			"failed",
			"skipped",
		]);
	});
});
