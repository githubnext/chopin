import { describe, expect, test } from "bun:test";
import type { JobOutcome } from "./jobs";
import { harness } from "./planner-jobs.test-fixtures";

describe("createPlannerJobs", () => {
	test("a legacy event without a matching source keeps its effect pending", async () => {
		let h = harness(async () => ({ status: "done", output: "{}" }));
		h.plan.conversationPlan.events = [{
			id: "card-event",
			type: "card.linked",
			threadId: "t1",
			questionnaireId: "W1",
		}];
		let intent = { kind: "refine" as const, target: "W1", trigger: "card-event" };
		h.plan.conversationPlanPendingEffects = [{
			key: "job:refine:W1:card-event",
			kind: "job",
			threadId: "t1",
			intent,
		}];
		await expect(h.service.enqueue(intent, "job:refine:W1:card-event"))
			.rejects.toThrow("source message");
		expect(h.service.jobs()).toEqual([]);
		expect(h.plan.conversationPlanPendingEffects).toHaveLength(1);
		expect(h.plan.conversationPlanEffects).toEqual([]);
	});

	test("stop during the running commit fences the runner and its publication", async () => {
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let called = 0;
		let h = harness(async () => {
			called++;
			return { status: "done", output: "{}" };
		}, {
			waitPersist: async attempt => {
				if (attempt !== 2) return;
				entered.resolve();
				await release.promise;
			},
		});
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await entered.promise;
		h.service.stop();
		release.resolve();
		await h.service.idle();
		expect(called).toBe(0);
		expect(h.commits.map(commit => commit.jobs[0]?.status)).toEqual(["pending", "running"]);
		expect(h.published).toEqual([["refine:W1:m1:pending"]]);
	});

	test("a wake during active work drains newly enqueued work before idle", async () => {
		let finish: ((outcome: JobOutcome) => void) | undefined;
		let seen: string[] = [];
		let h = harness(job => {
			seen.push(job.id);
			return seen.length === 1
				? new Promise(resolve => {
					finish = resolve;
				})
				: Promise.resolve({ status: "done", output: "{}" });
		});
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		for (let attempt = 0; attempt < 10; attempt++) {
			if (finish) break;
			await Promise.resolve();
		}
		expect(finish).toBeDefined();
		await h.service.enqueue({ kind: "suggest", target: "W1", trigger: "m2" });
		finish!({ status: "done", output: "{}" });
		await h.service.idle();
		expect(seen).toEqual(["refine:W1:m1", "suggest:W1:m2"]);
		expect(h.service.jobs().map(job => job.status)).toEqual(["done", "done"]);
	});

	test("a durable completion wakes the effects outbox to use freed capacity", async () => {
		let observed: string[] = [];
		let h = harness(async () => ({ status: "done", output: "{}" }), {
			onCapacityAvailable: () => {
				observed.push(h.commits.at(-1)?.jobs[0]?.status ?? "missing");
			},
		});
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await h.service.idle();
		expect(observed).toEqual(["done"]);
	});

	test("a durable skip wakes the effects outbox to reclaim terminal capacity", async () => {
		let observed: string[] = [];
		let h = harness(async () => ({ status: "skipped", reason: "AGENT=off" }), {
			onCapacityAvailable: () => {
				observed.push(h.commits.at(-1)?.jobs[0]?.status ?? "missing");
			},
		});
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await h.service.idle();
		expect(observed).toEqual(["skipped"]);
	});

	test("thrown runner errors become bounded, retryable failure reasons", async () => {
		let h = harness(async () => {
			throw new Error("x".repeat(1000));
		});
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await h.service.idle();
		expect(h.service.jobs()[0]).toMatchObject({ status: "failed", attempts: 1 });
		expect(h.service.jobs()[0]?.reason).toHaveLength(500);
	});
});
