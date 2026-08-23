import { describe, expect, it } from "bun:test";

import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { cancelResearchWorkspaceJob, getJob, listJobs } from "./browser";
import { JobRegistry } from "./registry";
import { researchAnswerDefinition, researchEvidenceDefinition } from "./research-workspace";
import { JobService } from "./service";

function registry(): JobRegistry {
	return new JobRegistry([
		researchEvidenceDefinition({
			config: { agent: true, model: "model" },
			engine: async () => ({ findings: [], sources: [] }),
		}),
		researchAnswerDefinition({
			config: { agent: true, model: "model" },
			engines: {
				private: async () => ({ findings: [] }),
				synthesize: async () => ({
					title: "Report",
					summary: "Summary",
					findings: [],
					caveats: [],
				}),
				answer: async () => ({ text: "Answer", sourceUrls: [] }),
			},
		}),
	]);
}

function answerInput(workspaceId: string, turnId: string, question: string) {
	let source = "# Document\n";
	return {
		workspaceId,
		turnId,
		kind: "initial" as const,
		question,
		document: {
			source,
			revision: 1,
			sourceHash: `sha256:${new Bun.CryptoHasher("sha256").update(source).digest("hex")}`,
		},
		evidence: [],
		history: [],
	};
}

describe("browser background jobs", () => {
	it("lists safe workspace subjects and cancels active user research jobs", async () => {
		let context = await openPlan("# Document\n");
		try {
			let service = new JobService({
				storage: context.storage,
				registry: registry(),
				lease: () => context.lease,
			});
			let workspaceId = "workspace-one";
			let turnId = "turn-one";
			let evidence = await service.enqueueUser({
				channelId: context.channel.id,
				type: "research-evidence",
				targetKey: `workspace:${workspaceId}:turn:${turnId}:evidence`,
				idempotencyKey: "evidence-one",
				input: { workspaceId, turnId, query: "What changed?" },
			});
			let answer = await service.enqueueUser({
				channelId: context.channel.id,
				type: "research-answer",
				targetKey: `workspace:${workspaceId}:turn:${turnId}:answer`,
				idempotencyKey: "answer-one",
				input: answerInput(workspaceId, turnId, "Which clients were tested?"),
			});

			let listed = await listJobs(service, context.channel.id);
			expect(Object.fromEntries(listed.jobs.map(job => [job.type, job.subject]))).toEqual({
				"research-answer": "Which clients were tested?",
				"research-evidence": "What changed?",
			});
			expect((await getJob(service, context.channel.id, answer.job.id)).detail?.job.subject)
				.toBe("Which clients were tested?");
			expect(
				(await cancelResearchWorkspaceJob(service, context.channel.id, evidence.job.id)).job.state,
			).toBe("cancelled");
			expect(
				(await cancelResearchWorkspaceJob(service, context.channel.id, evidence.job.id)).job.state,
			).toBe("cancelled");
			expect(
				(await cancelResearchWorkspaceJob(service, context.channel.id, answer.job.id)).job.state,
			).toBe("cancelled");
		} finally {
			await Plan.close(context.plan);
			await context.storage.close();
		}
	});

	it("replays cancelled jobs and rejects missing, stale, planner, and arbitrary targets", async () => {
		let context = await openPlan("# Document\n");
		try {
			let service = new JobService({
				storage: context.storage,
				registry: registry(),
				lease: () => context.lease,
			});
			let evidence = (targetKey: string, idempotencyKey: string) => ({
				channelId: context.channel.id,
				type: "research-evidence",
				targetKey,
				idempotencyKey,
				input: { workspaceId: "workspace", turnId: idempotencyKey, query: "What changed?" },
			});
			await expect(cancelResearchWorkspaceJob(service, context.channel.id, "missing"))
				.rejects.toThrow("not cancellable");

			let planner = await service.enqueuePlanner(evidence("workspace:planner", "planner"));
			await expect(cancelResearchWorkspaceJob(service, context.channel.id, planner.job.id))
				.rejects.toThrow("not cancellable");

			let inactive = await service.enqueueUser(evidence("workspace:inactive", "inactive"));
			await service.cancel({ channelId: context.channel.id, jobId: inactive.job.id });
			expect(
				(await cancelResearchWorkspaceJob(service, context.channel.id, inactive.job.id)).job.state,
			).toBe("cancelled");

			let old = await service.enqueueUser(evidence("workspace:current", "old"));
			let current = await service.enqueueUser(evidence("workspace:current", "current"));
			await expect(cancelResearchWorkspaceJob(service, context.channel.id, old.job.id))
				.rejects.toThrow("not cancellable");
			expect(
				(await cancelResearchWorkspaceJob(service, context.channel.id, current.job.id)).job.state,
			).toBe("cancelled");

			let now = new Date();
			let arbitrary = await context.storage.jobs.enqueue({
				id: crypto.randomUUID(),
				channelId: context.channel.id,
				type: "document-summary",
				version: 1,
				origin: "user",
				targetKey: "document-summary:document",
				idempotencyKey: crypto.randomUUID(),
				fingerprint: crypto.randomUUID(),
				input: { revision: 1 },
				availableAt: now,
				now,
				lease: context.lease,
			});
			await expect(cancelResearchWorkspaceJob(service, context.channel.id, arbitrary.job.id))
				.rejects.toThrow("not cancellable");
		} finally {
			await Plan.close(context.plan);
			await context.storage.close();
		}
	});
});
