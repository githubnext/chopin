import { expect, test } from "bun:test";
import { memoryJobs, message } from "./planner-jobs-memory.test-fixtures";
import { until } from "./service.test-fixtures";

test("real processor commits a heading receipt and running job before Planner execution", async () => {
	let h = await memoryJobs();
	let runs = 0;
	try {
		let { processor, jobs } = h.start(async (job, prompt) => {
			runs++;
			let saved = await h.saved();
			expect(saved.conversationPlanEffects).toEqual(["job:heading:document"]);
			expect(saved.conversationPlanPendingEffects).toBeUndefined();
			expect(saved.conversationPlanJobs).toMatchObject([{ id: job.id, status: "running" }]);
			expect(saved.transcript).toEqual([message]);
			expect(prompt).toContain("[Background job: heading]");
			return { status: "done", output: "{}" };
		});
		await processor.accept(message);
		processor.afterMessage();
		await until(() => h.plan.conversationPlanJobs[0]?.status === "done");
		await jobs.idle();
		let completed = await h.saved();
		expect(completed.conversationPlanJobs).toMatchObject([{ status: "done", attempts: 1 }]);
		expect(completed.transcript.map(entry => entry.text)).toEqual([
			message.text,
			"Chopin drafted the title and goal",
		]);
		expect(h.publications.map(jobs => jobs[0]?.status)).toEqual(["pending", "running", "done"]);
		await h.reopen();
		({ processor, jobs } = h.start(async () => {
			runs++;
			return { status: "done", output: "{}" };
		}));
		processor.afterMessage();
		jobs.wake();
		await jobs.idle();
		expect(h.plan.conversationPlanJobs[0]?.status).toBe("done");
		expect(runs).toBe(1);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
});

test("a real persisted Planner failure reopens as failed and only explicit retry runs it", async () => {
	let h = await memoryJobs();
	let runs = 0;
	try {
		let { processor, jobs } = h.start(async () => {
			runs++;
			throw new Error("runner unavailable");
		});
		await processor.accept(message);
		processor.afterMessage();
		await until(() => h.plan.conversationPlanJobs[0]?.status === "failed");
		await jobs.idle();
		expect((await h.saved()).conversationPlanJobs).toMatchObject([{
			status: "failed",
			attempts: 1,
		}]);
		await h.reopen();
		({ jobs } = h.start(async () => {
			runs++;
			return { status: "done", output: "{}" };
		}));
		jobs.wake();
		await jobs.idle();
		expect(runs).toBe(1);
		expect(await jobs.retry(h.plan.conversationPlanJobs[0]!.id)).toBe(true);
		await jobs.idle();
		expect((await h.saved()).conversationPlanJobs).toMatchObject([{ status: "done", attempts: 2 }]);
		expect(runs).toBe(2);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
});
