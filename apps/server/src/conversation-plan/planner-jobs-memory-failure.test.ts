import { expect, test } from "bun:test";
import { memoryJobs, message } from "./planner-jobs-memory.test-fixtures";
import { until } from "./service.test-fixtures";

test("a failed actual enqueue keeps its outbox effect without a receipt and retries after reopen", async () => {
	let h = await memoryJobs();
	let runs = 0;
	try {
		h.rejectCommits(input =>
			!!(input.sidecar as { conversationPlanEffects?: string[] })
				.conversationPlanEffects?.includes("job:heading:document")
		);
		let { processor, jobs } = h.start(async () => {
			runs++;
			return { status: "done", output: "{}" };
		});
		await processor.accept(message);
		processor.afterMessage();
		await until(() => h.errors.length > 0);
		await jobs.idle();
		let held = await h.saved();
		expect(held.conversationPlanJobs).toBeUndefined();
		expect(held.conversationPlanEffects).toBeUndefined();
		expect(held.conversationPlanPendingEffects).toMatchObject([{ key: "job:heading:document" }]);
		expect(h.plan.conversationPlanJobs).toEqual([]);
		expect(h.publications).toEqual([]);
		expect(runs).toBe(0);
		h.rejectCommits(() => false);
		await h.reopen();
		({ processor, jobs } = h.start(async () => {
			runs++;
			return { status: "done", output: "{}" };
		}));
		processor.afterMessage();
		await until(() => h.plan.conversationPlanJobs[0]?.status === "done");
		await jobs.idle();
		let settled = await h.saved();
		expect(settled.conversationPlanEffects).toEqual(["job:heading:document"]);
		expect(settled.conversationPlanPendingEffects).toBeUndefined();
		expect(runs).toBe(1);
	} finally {
		h.rejectCommits(() => false);
		await h.close();
	}
});

test("stopping a real held runner retains running durability until reopen records interruption", async () => {
	let h = await memoryJobs();
	let entered = Promise.withResolvers<void>();
	let runs = 0;
	try {
		let { processor, jobs } = h.start(async (_job, _prompt, signal) => {
			runs++;
			entered.resolve();
			await new Promise<void>(resolve =>
				signal!.addEventListener("abort", () => resolve(), { once: true })
			);
			return { status: "done", output: "{}" };
		});
		await processor.accept(message);
		processor.afterMessage();
		await entered.promise;
		jobs.stop();
		await jobs.idle();
		expect((await h.saved()).conversationPlanJobs).toMatchObject([{
			status: "running",
			attempts: 0,
		}]);
		expect(h.publications.map(jobs => jobs[0]?.status)).toEqual(["pending", "running"]);
		await h.reopen();
		expect((await h.saved()).conversationPlanJobs).toMatchObject([{
			status: "failed",
			reason: "interrupted",
			attempts: 0,
		}]);
		({ jobs } = h.start(async () => {
			runs++;
			return { status: "done", output: "{}" };
		}));
		jobs.wake();
		await jobs.idle();
		expect(runs).toBe(1);
		expect(h.plan.chat.entries).toEqual([message]);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
});
