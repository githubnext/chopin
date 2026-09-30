import { describe, expect, test } from "bun:test";
import * as Jobs from "./jobs";
import { AT, harness, interrupt } from "./planner-jobs.test-fixtures";

describe("createPlannerJobs", () => {
	test("interruption persistence failure leaves running status unpublished", async () => {
		let entered = Promise.withResolvers<void>();
		let h = harness(async (_job, _prompt, signal) => {
			entered.resolve();
			await new Promise<void>(resolve =>
				signal?.addEventListener("abort", () => resolve(), { once: true })
			);
			return { status: "failed", reason: "stopped" };
		}, { failPersist: attempt => attempt === 3 });
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await entered.promise;
		h.service.stop();
		await h.service.idle();
		let before = h.plan.conversationPlanJobs;
		let published = h.published.length;
		await expect(interrupt(h)).rejects.toThrow("storage failure 3");
		expect(h.plan.conversationPlanJobs).toBe(before);
		expect(h.plan.conversationPlanJobs[0]?.status).toBe("running");
		expect(h.published).toHaveLength(published);
	});

	test("enqueue after stop rejects so an effect receipt cannot consume unqueued work", async () => {
		let h = harness(async () => ({ status: "done", output: "{}" }));
		h.service.stop();
		await expect(h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" }))
			.rejects.toThrow("Planner job service is stopped");
		expect(h.service.jobs()).toEqual([]);
		expect(h.commits).toEqual([]);
	});

	test("stop while enqueue waits for the lock does not acknowledge an uncommitted job", async () => {
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let h = harness(async () => ({ status: "done", output: "{}" }), {
			exclusive: async action => {
				entered.resolve();
				await release.promise;
				return action();
			},
		});
		let pending = h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await entered.promise;
		h.service.stop();
		release.resolve();
		await expect(pending).rejects.toThrow("Planner job service is stopped");
		expect(h.service.jobs()).toEqual([]);
		expect(h.commits).toEqual([]);
	});

	test("a keyed enqueue commits a coalesced intent and receipt together", async () => {
		let ran: string[] = [];
		let h = harness(async job => {
			ran.push(job.id);
			return { status: "done", output: "{}" };
		});
		h.plan.conversationPlanJobs = Jobs.enqueue([], {
			kind: "refine",
			target: "W1",
			trigger: "m1",
		}, AT);
		let intent = { kind: "suggest" as const, target: "W1", trigger: "m2" };
		h.plan.conversationPlanPendingEffects = [{
			key: "job:suggest:W1:e2",
			kind: "job",
			threadId: "t1",
			intent,
		}];
		await h.service.enqueue(intent, "job:suggest:W1:e2");
		await h.service.idle();
		expect(h.commits[0]).toMatchObject({
			jobs: [{ id: "refine:W1:m1", status: "pending" }],
			pending: [],
			receipts: ["job:suggest:W1:e2"],
		});
		expect(ran).toEqual(["refine:W1:m1"]);
		let commits = h.commits.length;
		await h.service.enqueue(intent, "job:suggest:W1:e2");
		await h.service.idle();
		expect(h.commits).toHaveLength(commits);
		expect(h.service.jobs()).toHaveLength(1);
		expect(ran).toEqual(["refine:W1:m1"]);
	});

	test("a failed keyed commit restores the job queue, pending effect, and receipt", async () => {
		let h = harness(async () => ({ status: "done", output: "{}" }), {
			failPersist: attempt => attempt === 1,
		});
		let intent = { kind: "refine" as const, target: "W1", trigger: "m1" };
		h.plan.conversationPlanPendingEffects = [{
			key: "job:refine:W1:e1",
			kind: "job",
			threadId: "t1",
			intent,
		}];
		let jobs = h.plan.conversationPlanJobs;
		let pending = h.plan.conversationPlanPendingEffects;
		let receipts = h.plan.conversationPlanEffects;
		await expect(h.service.enqueue(intent, "job:refine:W1:e1"))
			.rejects.toThrow("storage failure 1");
		expect(h.plan.conversationPlanJobs).toBe(jobs);
		expect(h.plan.conversationPlanPendingEffects).toBe(pending);
		expect(h.plan.conversationPlanEffects).toBe(receipts);
		expect(h.published).toEqual([]);
		await h.service.enqueue(intent, "job:refine:W1:e1");
		await h.service.idle();
		expect(h.commits[0]?.receipts).toEqual(["job:refine:W1:e1"]);
		expect(h.service.jobs()[0]?.status).toBe("done");
	});
});
