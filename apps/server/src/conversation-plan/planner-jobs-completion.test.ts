import { describe, expect, test } from "bun:test";
import type { JobOutcome } from "./jobs";
import { harness } from "./planner-jobs.test-fixtures";

describe("createPlannerJobs", () => {
	test("a failed job can be retried once, and a completed job cannot", async () => {
		let attempts = 0;
		let h = harness(async () =>
			++attempts === 1
				? { status: "failed", reason: "Copilot unavailable" }
				: { status: "done", output: "{}" }
		);
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await h.service.idle();
		expect(h.service.jobs()[0]).toMatchObject({
			status: "failed",
			attempts: 1,
			reason: "Copilot unavailable",
		});
		expect(await h.service.retry("refine:W1:m1")).toBe(true);
		await h.service.idle();
		expect(h.service.jobs()[0]).toMatchObject({ status: "done", attempts: 2 });
		expect(await h.service.retry("refine:W1:m1")).toBe(false);
		expect(attempts).toBe(2);
	});

	test("closed cards skip their work without invoking the runner", async () => {
		let called = 0;
		let h = harness(async () => {
			called++;
			return { status: "done", output: "{}" };
		});
		h.plan.records.get("W1")!.status = "answered";
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await h.service.idle();
		expect(called).toBe(0);
		expect(h.service.jobs()[0]).toMatchObject({ status: "skipped", attempts: 1 });
		expect(h.lines).toEqual([]);
	});

	test("the heading precondition is checked while enqueue holds the document lock", async () => {
		let h = harness(async () => ({ status: "done", output: "{}" }), {
			headingAllowed: () => false,
		});
		await h.service.enqueue({ kind: "heading", target: "document", trigger: "m1" });
		await h.service.idle();
		expect(h.service.jobs()).toEqual([]);
		expect(h.commits).toEqual([]);
	});

	test("invalid runner output becomes a bounded failure, including malformed JSON", async () => {
		let h = harness(async () => ({ status: "done", output: "not JSON" }));
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await h.service.idle();
		expect(h.service.jobs()[0]).toMatchObject({
			status: "failed",
			reason: "Invalid Planner job output.",
		});
		expect(h.lines).toEqual([]);
	});

	test("a valid JSON primitive cannot crash activity formatting", async () => {
		let h = harness(async () => ({ status: "done", output: "null" }));
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await h.service.idle();
		expect(h.service.jobs()[0]?.status).toBe("done");
		expect(h.lines).toEqual(["Chopin refined What auth system should we use?"]);
	});

	test("a storage failure at start leaves a pending job and does not spin", async () => {
		let called = 0;
		let h = harness(async () => {
			called++;
			return { status: "done", output: "{}" };
		}, { failPersist: attempt => attempt === 2 });
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await h.service.idle();
		expect(h.service.jobs()[0]?.status).toBe("pending");
		expect(h.commits).toHaveLength(1);
		expect(h.errors).toHaveLength(1);
		expect(called).toBe(0);
		h.service.wake();
		await h.service.idle();
		expect(h.service.jobs()[0]?.status).toBe("done");
		expect(called).toBe(1);
	});

	test("a failed activity commit restores the running job and removes its line", async () => {
		let h = harness(async () => ({ status: "done", output: "{}" }), {
			failPersist: attempt => attempt === 3,
		});
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await h.service.idle();
		expect(h.service.jobs()[0]?.status).toBe("running");
		expect(h.commits.map(commit => commit.jobs[0]?.status)).toEqual(["pending", "running"]);
		expect(h.lines).toEqual([]);
		expect(h.published.at(-1)).toEqual(["refine:W1:m1:running"]);
		expect(h.errors).toHaveLength(1);
	});

	test("stop fences a late runner result and leaves durable running work for recovery", async () => {
		let finish: ((outcome: JobOutcome) => void) | undefined;
		let h = harness(() =>
			new Promise(resolve => {
				finish = resolve;
			})
		);
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		for (let attempt = 0; attempt < 10; attempt++) {
			if (finish) break;
			await Promise.resolve();
		}
		expect(finish).toBeDefined();
		h.service.stop();
		finish!({ status: "done", output: "{}" });
		await h.service.idle();
		expect(h.service.jobs()[0]?.status).toBe("running");
		expect(h.commits).toHaveLength(2);
		expect(h.published.at(-1)).toEqual(["refine:W1:m1:running"]);
		expect(h.lines).toEqual([]);
	});
});
