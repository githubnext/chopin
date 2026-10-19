import { expect, it } from "bun:test";
import { ResearchWorkspaceService } from "./service";
import {
	answerArtifact,
	evidenceArtifact,
	requestId,
	settle,
	setup,
	SOURCE,
	SOURCE_HASH,
} from "./test-support";
import { failInitialEvidence } from "./inline.test-fixtures";

import type { ResearchTestContext } from "./test-support";

function serviceWith(
	context: ResearchTestContext,
	followedByDecision?: (channelId: string, workspaceId: string) => Promise<boolean>,
) {
	let notices: Array<{ id: string; text: string }> = [];
	let service = new ResearchWorkspaceService({
		storage: context.storage,
		jobs: context.jobs,
		lease: () => context.lease,
		current: async channelId => ({
			channelId,
			revision: 7,
			source: SOURCE,
			sourceHash: SOURCE_HASH,
		}),
		publish: () => {},
		terminalNotice: async (_channelId, id, text) => {
			notices.push({ id, text });
		},
		...(followedByDecision ? { followedByDecision } : {}),
	});
	return { service, notices };
}

async function failedRequest(context: ResearchTestContext) {
	let started = await context.service.start({
		channelId: context.channelId,
		question: "Compare the public providers",
		requestId: requestId(9),
		requestedBy: context.userId,
		requestedByHandle: "octocat",
	});
	let jobId = await failInitialEvidence(context);
	let failed = await context.jobs.get(context.channelId, jobId);
	if (!failed) throw new Error("failed research job is missing");
	return { workspaceId: started.request.id, jobId, job: failed.job };
}

it("posts one failure notice for a request that never placed an inline reference", async () => {
	let context = await setup();
	let { workspaceId, jobId, job } = await failedRequest(context);
	let { service, notices } = serviceWith(context);
	await service.jobChanged(job);
	await service.jobChanged(job);
	expect(notices).toHaveLength(2);
	expect(notices[0]).toEqual({
		id: `research-failed:${workspaceId}:${jobId}`,
		text: "Research could not be completed. You can retry it from the research card.",
	});
	// The host's noticeOnce makes the repeat a no-op; the id is what keeps it idempotent.
	expect(notices[1]).toEqual(notices[0]!);
});

it("leaves a failed request to its decision finding's own notice", async () => {
	let context = await setup();
	let { workspaceId, job } = await failedRequest(context);
	let asked: string[] = [];
	let { service, notices } = serviceWith(context, async (_channelId, id) => {
		asked.push(id);
		return true;
	});
	await service.jobChanged(job);
	expect(asked).toEqual([workspaceId]);
	expect(notices).toEqual([]);
});

it("keeps the ready notice for a placed reference only", async () => {
	let context = await setup();
	await context.service.start({
		channelId: context.channelId,
		question: "Compare the public providers",
		requestId: requestId(11),
		requestedBy: context.userId,
		requestedByHandle: "octocat",
	});
	let { service, notices } = serviceWith(context);
	let evidence = await settle(context, "research-evidence", evidenceArtifact);
	await service.jobChanged(evidence.job);
	let answer = await settle(context, "research-answer", answerArtifact);
	await service.jobChanged(answer.job);
	expect(notices).toEqual([]);
});
