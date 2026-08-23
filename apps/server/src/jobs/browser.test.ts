import { describe, expect, it } from "bun:test";

import { assignResearchQuestion, cancelResearchJob, getJob, listJobs } from "./browser";
import { JobRegistry } from "./registry";
import { researchQuestionDefinition } from "./research-question";
import { JobService } from "./service";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";

const ID = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const SOURCE = `<ResearchQuestion id="${ID}">\n\nWhat changed?\n\n</ResearchQuestion>\n`;

describe("browser background jobs", () => {
	it("derives a research assignment from canonical document state", async () => {
		let context = await openPlan(SOURCE);
		try {
			let definition = researchQuestionDefinition({
				config: { agent: true, model: "model" },
				current: async () => {
					let source = Plan.source(context.plan);
					return {
						channelId: context.channel.id,
						revision: context.plan.revision,
						source,
						sourceHash: Plan.sourceHash(source),
					};
				},
				commitCurrent: async () => false,
				engines: {
					public: async () => ({ findings: [], sources: [] }),
					private: async () => ({ findings: [] }),
					synthesize: async () => ({
						title: "Report",
						summary: "Summary",
						findings: [],
						caveats: [],
					}),
				},
			});
			let service = new JobService({
				storage: context.storage,
				registry: new JobRegistry([definition]),
				lease: () => context.lease,
			});
			let requestId = crypto.randomUUID();
			let assigned = await assignResearchQuestion(service, context.plan, ID, requestId);
			expect(assigned).toMatchObject({
				repeated: false,
				job: { type: "research-question", origin: "user", targetKey: `research-question:${ID}` },
			});
			let repeated = await assignResearchQuestion(service, context.plan, ID, requestId);
			expect(repeated.repeated).toBe(true);
			let stored = await context.storage.jobs.get(context.channel.id, assigned.job.id);
			expect(stored!.job.input).toMatchObject({
				questionId: ID,
				question: "What changed?",
				revision: 0,
			});

			let listed = await listJobs(service, context.channel.id);
			expect(listed.jobs).toHaveLength(1);
			expect("input" in listed.jobs[0]!).toBe(false);
			expect(listed.jobs[0]!.subject).toBe("What changed?");
			expect(listed.jobs[0]!.progress).toEqual([]);
			expect((await getJob(service, context.channel.id, assigned.job.id)).detail).toBeDefined();
			let cancelled = await cancelResearchJob(
				service,
				context.channel.id,
				assigned.job.id,
			);
			expect(cancelled.job.state).toBe("cancelled");
		} finally {
			await Plan.close(context.plan);
			await context.storage.close();
		}
	});

	it("rejects arbitrary, missing, or non-user cancellation targets", async () => {
		let context = await openPlan(SOURCE);
		try {
			let service = new JobService({
				storage: context.storage,
				registry: new JobRegistry(),
				lease: () => context.lease,
			});
			await expect(assignResearchQuestion(service, context.plan, "bad", crypto.randomUUID()))
				.rejects.toThrow("invalid");
			await expect(cancelResearchJob(service, context.channel.id, "missing"))
				.rejects.toThrow("not cancellable");
			let now = new Date();
			let scheduler = await context.storage.jobs.enqueue({
				id: crypto.randomUUID(),
				channelId: context.channel.id,
				type: "research-question",
				version: 1,
				origin: "scheduler",
				targetKey: `research-question:${ID}`,
				idempotencyKey: crypto.randomUUID(),
				fingerprint: crypto.randomUUID(),
				input: { questionId: ID },
				availableAt: now,
				now,
				lease: context.lease,
			});
			await expect(cancelResearchJob(service, context.channel.id, scheduler.job.id))
				.rejects.toThrow("not cancellable");
		} finally {
			await Plan.close(context.plan);
			await context.storage.close();
		}
	});
});
