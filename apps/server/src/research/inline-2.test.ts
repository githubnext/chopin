import { expect, it } from "bun:test";
import { ResearchWorkspaceService } from "./service";
import {
	answerArtifact,
	evidenceArtifact,
	REPOSITORY_ID,
	requestId,
	settle,
	setup,
} from "./test-support";
import { failInitialEvidence, terminalNotices } from "./inline.test-fixtures";

it("emits a stable failed notice without exposing a request ID", async () => {
	let context = await setup();
	let started = await context.service.startPlannerInline({
		channelId: context.channelId,
		question: "Check the release",
		originMessageId: "message-failed",
		requestedBy: context.userId,
		placeReference: async () => "placed",
	});
	let failedJobId = await failInitialEvidence(context);
	let failed = await context.jobs.get(context.channelId, failedJobId);
	if (!failed) throw new Error("failed research job is missing");
	let { service, notices } = terminalNotices(context);
	await service.jobChanged(failed.job);
	expect((await service.request(context.channelId, started.request.id))?.stage).toBe("failed");
	expect(notices).toEqual([{
		channelId: context.channelId,
		id: `research-failed:${started.request.id}:${failedJobId}`,
		text: "Research could not be completed. You can retry it from the research card.",
	}]);
	expect(notices[0]!.text).not.toContain(started.request.id);
	await service.jobChanged(failed.job);
	expect(notices[1]).toEqual(notices[0]);
});

it("recovers missed ready and failed notices across repeated startup scans", async () => {
	let context = await setup();
	let ready = await context.service.startPlannerInline({
		channelId: context.channelId,
		question: "Check the release",
		originMessageId: "missed-ready",
		requestedBy: context.userId,
		placeReference: async () => "placed",
	});
	let evidence = await settle(context, "research-evidence", evidenceArtifact);
	await context.service.jobChanged(evidence.job);
	let answer = await settle(context, "research-answer", answerArtifact);
	await context.service.jobChanged(answer.job);
	let failed = await context.service.startPlannerInline({
		channelId: context.channelId,
		question: "Check the failure",
		originMessageId: "missed-failed",
		requestedBy: context.userId,
		placeReference: async () => "placed",
	});
	let failedJobId = await failInitialEvidence(context);
	let notices = new Map<string, string>();
	let recovered = new ResearchWorkspaceService({
		storage: context.storage,
		jobs: context.jobs,
		lease: () => context.lease,
		current: async () => undefined,
		publish: () => {},
		terminalNotice: async (_channelId, id, text) => {
			let previous = notices.get(id);
			if (previous && previous !== text) throw new Error("conflicting notice");
			notices.set(id, text);
		},
	});
	await recovered.recoverTerminalPlannerInline();
	expect([...notices.keys()]).toEqual([
		`research-ready:${ready.request.id}:${answer.job.id}`,
		`research-failed:${failed.request.id}:${failedJobId}`,
	]);
	await recovered.recoverTerminalPlannerInline();
	expect(notices.size).toBe(2);
});

it("does not announce terminal legacy research without an inline card", async () => {
	let context = await setup();
	await context.service.start({
		channelId: context.channelId,
		question: "Old research",
		requestId: requestId(75),
		requestedBy: context.userId,
	});
	let failedJobId = await failInitialEvidence(context);
	let failed = await context.jobs.get(context.channelId, failedJobId);
	if (!failed) throw new Error("failed research job is missing");
	let { service, notices } = terminalNotices(context);
	await service.jobChanged(failed.job);
	expect(notices).toEqual([]);
});

it("places one inline Planner request before queueing or publishing it", async () => {
	let context = await setup();
	let references = new Set<string>();
	let placements = 0;
	let input = {
		channelId: context.channelId,
		question: "Which public evidence supports version 3?",
		originMessageId: "01K39QZG000000000000000003",
		requestedBy: context.userId,
		placeReference: async (id: string) => {
			placements++;
			if (placements === 1) {
				expect((await context.jobs.list(context.channelId, 100))?.jobs).toEqual([]);
				expect(context.publications).toEqual([]);
				expect(
					(await context.storage.research.get(context.channelId, id))?.workspace
						.inlineReference,
				).toBe("pending");
			}
			references.add(id);
			return "placed" as const;
		},
	};
	let started = await context.service.startPlannerInline(input);
	expect(references.has(started.request.id)).toBe(true);
	expect(started.request).toMatchObject({ state: "pending", stage: "queued" });
	expect((await context.storage.research.get(context.channelId, started.request.id))?.workspace)
		.toMatchObject({ origin: "planner", originMessageId: input.originMessageId });
	expect(context.publications).toHaveLength(1);
	expect(await context.service.request(context.channelId, started.request.id))
		.toMatchObject({ id: started.request.id, stage: "queued" });
	expect(await context.service.get(context.channelId, started.request.id)).toBeUndefined();
	expect(await context.service.list(context.channelId)).toEqual([]);
	expect((await context.service.listRepository(REPOSITORY_ID)).channels).toEqual([]);
	let replay = await context.service.startPlannerInline(input);
	expect(replay).toEqual({ ...started, repeated: true });
	expect(placements).toBe(2);
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toHaveLength(1);
});
