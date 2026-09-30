import { describe, expect, test } from "bun:test";
import { createPlannerJobs } from "./planner-jobs";
import { AT, harness, interrupt } from "./planner-jobs.test-fixtures";

describe("createPlannerJobs", () => {
	test("stop aborts a held scripted runner while retaining its durable running status", async () => {
		let entered = Promise.withResolvers<void>();
		let supplied = false;
		let aborted = false;
		let h = harness(async (_job, _prompt, signal) => {
			entered.resolve();
			if (!signal) throw new Error("runner signal is missing");
			supplied = true;
			await new Promise<void>(resolve =>
				signal.addEventListener("abort", () => resolve(), {
					once: true,
				})
			);
			aborted = signal.aborted;
			return { status: "skipped", reason: "stopped" };
		});
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await entered.promise;
		h.service.stop();
		await h.service.idle();
		expect(supplied).toBe(true);
		expect(aborted).toBe(true);
		expect(h.service.jobs()[0]?.status).toBe("running");
		expect(h.commits).toHaveLength(2);
	});

	test("in-memory restart durably interrupts running work and drains later pending work", async () => {
		let entered = Promise.withResolvers<void>();
		let called: string[] = [];
		let h = harness(async (job, _prompt, signal) => {
			called.push(job.id);
			if (called.length > 1) return { status: "done", output: "{}" };
			entered.resolve();
			await new Promise<void>(resolve =>
				signal?.addEventListener("abort", () => resolve(), { once: true })
			);
			return { status: "failed", reason: "stopped" };
		});
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await entered.promise;
		await h.service.enqueue({ kind: "suggest", target: "W1", trigger: "m2" });
		h.service.stop();
		await h.service.idle();
		expect(h.service.jobs().map(job => job.status)).toEqual(["running", "pending"]);
		expect(await interrupt(h)).toBe(true);
		expect(h.commits.at(-1)?.jobs).toMatchObject([
			{ status: "failed", reason: "interrupted" },
			{ status: "pending" },
		]);
		expect(h.published.at(-1)).toEqual([
			"refine:W1:m1:failed",
			"suggest:W1:m2:pending",
		]);
		expect(h.publishedAfter.at(-1)).toBe(h.commits.length);
		let restarted = createPlannerJobs({
			plan: h.plan as never,
			exclusive: async action => action(),
			persist: h.persist,
			runner: async job => {
				called.push(job.id);
				return { status: "done", output: "{}" };
			},
			prompt: () => "prompt",
			publishJobs: () => {},
			publishMeta: () => {},
			activity: h.persist,
			now: () => AT,
		});
		restarted.wake();
		await restarted.idle();
		expect(called).toEqual(["refine:W1:m1", "suggest:W1:m2"]);
		expect(h.plan.conversationPlanJobs.map(job => job.status)).toEqual(["failed", "done"]);
	});

	test("an interrupted old prose generation does not replay after restart", async () => {
		let entered = Promise.withResolvers<void>();
		let h = harness(async (_job, _prompt, signal) => {
			entered.resolve();
			await new Promise<void>(resolve =>
				signal?.addEventListener("abort", () => resolve(), { once: true })
			);
			return { status: "failed", reason: "stopped" };
		});
		h.plan.records.set("W1", {
			id: "W1",
			status: "answered",
			origin: "conversation",
			threadId: "t1",
			owner: "ana",
			decidedAt: 1,
			history: [],
			definition: { questions: [{ question: "Decision", options: [] }] },
		} as never);
		await h.service.enqueue({ kind: "prose", target: "W1", trigger: "decided:W1:1" });
		await entered.promise;
		let previous = h.plan.records.get("W1")!;
		h.plan.records.set("W1", { ...previous, history: [{}] } as never);
		await h.service.enqueue({ kind: "prose", target: "W1", trigger: "decided:W1:2" });
		h.service.stop();
		await h.service.idle();
		expect(await interrupt(h)).toBe(true);
		let ran: string[] = [];
		let restarted = createPlannerJobs({
			plan: h.plan as never,
			exclusive: async action => action(),
			persist: h.persist,
			runner: async job => {
				ran.push(job.trigger);
				return { status: "done", output: "{}" };
			},
			prompt: () => "prompt",
			publishJobs: () => {},
			publishMeta: () => {},
			activity: h.persist,
			now: () => AT,
		});
		restarted.wake();
		await restarted.idle();
		expect(h.service.jobs().map(job => [job.status, job.reason])).toEqual([
			["failed", "interrupted"],
			["done", undefined],
		]);
		expect(ran).toEqual(["decided:W1:2"]);
	});
});
