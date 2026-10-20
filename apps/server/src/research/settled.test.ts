import { expect, it } from "bun:test";
import { researchJobSettles, ResearchWorkspaceService } from "./service";
import { setup } from "./test-support";
import { failInitialEvidence } from "./inline.test-fixtures";
import type { Research } from "@chopin/protocol";

it("a failed evidence job, with no answer job, ends its request and settles listeners", async () => {
	let context = await setup();
	let started = await context.service.start({
		channelId: context.channelId,
		question: "Check the release",
		requestId: "7c2d4e6f-8a0b-4c1d-9e2f-3a4b5c6d7e8f",
		requestedBy: context.userId,
	});
	let failedJobId = await failInitialEvidence(context);
	let failed = await context.jobs.get(context.channelId, failedJobId);
	if (!failed) throw new Error("failed research job is missing");
	expect(failed.job.state).toBe("failed");
	// main.ts forwards a job to the service only when this holds.
	expect(researchJobSettles(failed.job)).toBe(true);
	expect(researchJobSettles({ type: "research-evidence", state: "running" })).toBe(false);
	// The runner requeues a failed attempt that has retries left as pending (runner.ts #retry).
	expect(researchJobSettles({ type: "research-evidence", state: "pending" })).toBe(false);
	expect(researchJobSettles({ type: "version-summary", state: "failed" })).toBe(false);
	let settled: Research.RequestView[] = [];
	let service = new ResearchWorkspaceService({
		storage: context.storage,
		jobs: context.jobs,
		lease: () => context.lease,
		current: async () => undefined,
		publish: () => {},
		settled: async (_channelId, request) => {
			settled.push(request);
		},
	});
	await service.jobChanged(failed.job);
	expect(settled.map(value => [value.id, value.stage])).toEqual([[started.request.id, "failed"]]);
});
