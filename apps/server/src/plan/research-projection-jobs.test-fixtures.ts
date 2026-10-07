import { ulid } from "@chopin/dialect";
import * as Service from "./service";
import { hosted } from "./conversation-persistence.test-fixtures";

export async function linkedResearchJob(
	context: Awaited<ReturnType<typeof hosted>>,
	workspaceId: string,
	role: "evidence" | "answer",
	channelId = context.channel.id,
) {
	let detail = await context.storage.research.get(channelId, workspaceId);
	let initial = detail?.turns.find(turn => turn.kind === "initial");
	if (!initial) throw new Error("initial research turn is missing");
	let type = `research-${role}`;
	let jobId = ulid();
	let targetKey = `${type}:workspace:${workspaceId}:turn:${initial.id}:${role}`;
	let created = await context.storage.jobs.enqueue({
		id: jobId,
		channelId,
		type,
		version: 1,
		origin: "user",
		targetKey,
		idempotencyKey: `research-test-${jobId}`,
		fingerprint: `research-test-${jobId}`,
		input: { workspaceId, turnId: initial.id, query: initial.question },
		availableAt: context.now,
		now: context.now,
		lease: context.lease,
	});
	await context.storage.research.linkJob({
		channelId,
		workspaceId,
		turnId: initial.id,
		role,
		jobId: created.job.id,
		now: context.now,
		lease: context.lease,
	});
	return created.job;
}

export async function setResearchJobState(
	context: Awaited<ReturnType<typeof hosted>>,
	jobId: string,
	state: "failed" | "cancelled" | "completed",
) {
	let [claimed] = await context.storage.jobs.claim({
		channelId: context.channel.id,
		claimOwner: `research-test-${jobId}`,
		count: 1,
		ttlMs: 30_000,
		now: context.now,
		lease: context.lease,
	});
	if (!claimed) throw new Error("research job was not claimable");
	if (state === "failed") {
		return context.storage.jobs.fail({
			channelId: context.channel.id,
			jobId,
			claimOwner: claimed.claimOwner!,
			claimGeneration: claimed.claimGeneration,
			reason: "test-failure",
			now: context.now,
			lease: context.lease,
		});
	}
	if (state === "completed") {
		return context.storage.jobs.settle({
			channelId: context.channel.id,
			jobId,
			claimOwner: claimed.claimOwner!,
			claimGeneration: claimed.claimGeneration,
			artifact: { completed: true },
			now: context.now,
			lease: context.lease,
		});
	}
	return context.storage.jobs.cancel({
		channelId: context.channel.id,
		jobId,
		now: context.now,
		lease: context.lease,
	});
}

export async function publishReadyResearch(
	context: Awaited<ReturnType<typeof hosted>>,
	workspaceId: string,
) {
	let answer = await linkedResearchJob(context, workspaceId, "answer");
	await setResearchJobState(context, answer.id, "completed");
	await context.storage.research.publishInitialReport({
		channelId: context.channel.id,
		workspaceId,
		answerJobId: answer.id,
		title: "Published research",
		initial: await Service.initial("# Published research\n"),
		now: context.now,
		lease: context.lease,
	});
}
