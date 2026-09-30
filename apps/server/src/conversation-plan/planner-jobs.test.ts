import { describe, expect, test } from "bun:test";
import * as Jobs from "./jobs";
import type { Job } from "./jobs";
import { AT, harness } from "./planner-jobs.test-fixtures";

describe("createPlannerJobs", () => {
	test("posts one durable prose activity line after a completed write", async () => {
		let h = harness(async () => ({
			status: "done",
			output: JSON.stringify({ title: "Which authentication approach?", mode: "insert" }),
		}));
		h.plan.records.set("W1", {
			id: "W1",
			status: "answered",
			origin: "conversation",
			threadId: "t1",
			owner: "mina",
			decidedAt: 1,
			history: [],
			definition: { questions: [{ question: "Which authentication approach?", options: [] }] },
		} as never);
		await h.service.enqueue({ kind: "prose", target: "W1", trigger: "decided:W1:1" });
		await h.service.idle();
		expect(h.lines).toEqual(["Chopin wrote up Which authentication approach?"]);
		expect(h.commits.at(-1)?.lines).toEqual(h.lines);
	});

	test("a queued old prose generation skips before prompting or invoking the runner", async () => {
		let ran: string[] = [];
		let h = harness(async job => {
			ran.push(job.trigger);
			return { status: "done", output: JSON.stringify({ title: "Decision" }) };
		});
		h.plan.records.set("W1", {
			id: "W1",
			status: "answered",
			origin: "conversation",
			threadId: "t1",
			owner: "cy",
			decidedAt: 1,
			history: [{ choices: [], owner: "ana", at: 1 }],
			definition: { questions: [{ question: "Decision", options: [] }] },
		} as never);
		h.plan.conversationPlanJobs = Jobs.enqueue(
			Jobs.enqueue([], { kind: "prose", target: "W1", trigger: "decided:W1:1" }, AT),
			{ kind: "prose", target: "W1", trigger: "decided:W1:2" },
			AT,
		);
		h.service.wake();
		await h.service.idle();
		expect(h.plan.conversationPlanJobs.map(job => job.status)).toEqual(["skipped", "done"]);
		expect(ran).toEqual(["decided:W1:2"]);
	});

	test("a prose turn superseded by a new decision does not announce an old success", async () => {
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let h = harness(async () => {
			entered.resolve();
			await release.promise;
			return { status: "done", output: JSON.stringify({ title: "Decision" }) };
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
		release.resolve();
		await h.service.idle();
		expect(h.service.jobs()[0]).toMatchObject({ status: "skipped" });
		expect(h.lines).toEqual([]);
	});

	test("persists running before the runner and completes with one durable activity line", async () => {
		let seen: Array<{ job: Job; committed: string }> = [];
		let h = harness(async job => {
			seen.push({ job, committed: h.commits.at(-1)!.jobs[0]!.status });
			return {
				status: "done",
				output: JSON.stringify({ title: "What auth system should we use?", added: 1 }),
			};
		});
		await h.service.enqueue({ kind: "refine", target: "W1", trigger: "m1" });
		await h.service.idle();
		expect(seen).toMatchObject([{
			job: { id: "refine:W1:m1", status: "running" },
			committed: "running",
		}]);
		expect(h.commits.map(commit => commit.jobs[0]?.status)).toEqual([
			"pending",
			"running",
			"done",
		]);
		expect(h.commits.at(-1)?.lines).toEqual([
			"Chopin refined What auth system should we use?",
		]);
		expect(h.published.at(-1)).toEqual(["refine:W1:m1:done"]);
		expect(h.publishedAfter).toEqual([1, 2, 3]);
		expect(h.meta).toEqual(["W1", "W1", "W1"]);
		expect(h.errors).toEqual([]);
	});

	test("suggestion activity appears only when an option was added", async () => {
		let added = [0, 2];
		let h = harness(async () => ({
			status: "done",
			output: JSON.stringify({ title: "Authentication?", added: added.shift() }),
		}));
		await h.service.enqueue({ kind: "suggest", target: "W1", trigger: "m1" });
		await h.service.idle();
		await h.service.enqueue({ kind: "suggest", target: "W1", trigger: "m2" });
		await h.service.idle();
		expect(h.lines).toEqual(["Chopin suggested 2 options for Authentication?"]);
		expect(h.commits).toHaveLength(6);
	});
});
