import { expect, it } from "bun:test";
import { answerArtifact, evidenceArtifact, settle, setup } from "./test-support";
import { acceptedOffer, terminalNotices } from "./inline.test-fixtures";

it("reads a pending, pre-job, then linked accepted request without starting work", async () => {
	let context = await setup();
	let offer = acceptedOffer(context.userId);
	expect(await context.service.acceptedOfferLink(context.channelId, offer))
		.toEqual({ status: "pending" });
	let placed = false;
	let input = {
		channelId: context.channelId,
		question: offer.brief,
		originMessageId: offer.source.messageId,
		requestedBy: offer.action!.principalId,
		requestedByHandle: offer.action!.actor.handle,
		placeReference: async () => {
			if (!placed) throw new Error("placement interrupted");
			return "placed" as const;
		},
	};
	await expect(context.service.startPlannerInline(input)).rejects.toThrow(
		"placement interrupted",
	);
	let beforeJobs = await context.jobs.list(context.channelId, 100);
	let beforePublications = context.publications.length;
	let preJob = await context.restart().acceptedOfferLink(context.channelId, offer);
	expect(preJob.status).toBe("unlinked");
	expect(typeof preJob.researchRequestId).toBe("string");
	if (!preJob.researchRequestId) throw new Error("pre-job request ID was not found");
	expect(await context.jobs.list(context.channelId, 100)).toEqual(beforeJobs);
	expect(context.publications).toHaveLength(beforePublications);
	placed = true;
	let started = await context.restart().startPlannerInline(input);
	expect(started.request.id).toBe(preJob.researchRequestId);
	expect(await context.restart().acceptedOfferLink(context.channelId, offer))
		.toEqual({ status: "linked", researchRequestId: started.request.id });
	for (let index = 0; index < 105; index++) {
		await context.storage.research.start({
			id: `other-${index}`,
			channelId: context.channelId,
			title: `Other ${index}`,
			question: `Other question ${index}`,
			origin: "planner",
			originMessageId: `other-message-${index}`,
			createdBy: context.userId,
			turnId: `other-turn-${index}`,
			messageId: `other-message-record-${index}`,
			requestId: `other-request-${index}`,
			idempotencyKey: `other-key-${index}`,
			fingerprint: `other-fingerprint-${index}`,
			now: context.advance(),
			lease: context.lease,
		});
	}
	expect((await context.storage.research.list(context.channelId, 100, true))
		.some(item => item.id === started.request.id)).toBe(false);
	expect(await context.restart().acceptedOfferLink(context.channelId, offer))
		.toEqual({ status: "linked", researchRequestId: started.request.id });
	expect(await context.service.acceptedOfferLink("other-channel", offer))
		.toEqual({ status: "pending" });
});

it("rejects colliding or altered original consent identities", async () => {
	let context = await setup();
	let offer = acceptedOffer(context.userId);
	await context.service.startPlannerInline({
		channelId: context.channelId,
		question: offer.brief,
		originMessageId: offer.source.messageId,
		requestedBy: context.userId,
		requestedByHandle: "octocat",
		placeReference: async () => "placed",
	});
	for (
		let changed of [
			{ ...offer, brief: "Different brief" },
			{ ...offer, action: { ...offer.action!, principalId: "another-user" } },
			{
				...offer,
				action: {
					...offer.action!,
					actor: { kind: "member" as const, handle: "someone-else" },
				},
			},
		]
	) {
		await expect(context.service.acceptedOfferLink(context.channelId, changed))
			.rejects.toMatchObject({ code: "invalid-state" });
	}
	await expect(context.service.acceptedOfferLink(context.channelId, {
		...offer,
		status: "dismissed",
	})).rejects.toMatchObject({ code: "invalid-request" });
	let ordinary = await setup();
	let ordinaryOffer = acceptedOffer(ordinary.userId);
	await ordinary.service.startPlanner({
		channelId: ordinary.channelId,
		question: ordinaryOffer.brief,
		originMessageId: ordinaryOffer.source.messageId,
		requestedBy: ordinary.userId,
		requestedByHandle: "octocat",
	});
	await expect(ordinary.service.acceptedOfferLink(ordinary.channelId, ordinaryOffer))
		.rejects.toMatchObject({ code: "invalid-state" });
});

it("emits a stable ready notice after publishing a Planner inline child", async () => {
	let context = await setup();
	let started = await context.service.startPlannerInline({
		channelId: context.channelId,
		question: "Check the release",
		originMessageId: "message-ready",
		requestedBy: context.userId,
		placeReference: async () => "placed",
	});
	let evidence = await settle(context, "research-evidence", evidenceArtifact);
	await context.service.jobChanged(evidence.job);
	let answer = await settle(context, "research-answer", answerArtifact);
	let { service, notices } = terminalNotices(context);
	await service.jobChanged(answer.job);

	let request = await service.request(context.channelId, started.request.id);
	if (request?.stage !== "ready") throw new Error("published research child is not ready");
	expect(notices).toEqual([{
		channelId: context.channelId,
		id: `research-ready:${started.request.id}:${answer.job.id}`,
		text: `Research is ready. [Open the research document](`
			+ `/documents/octo-org/score/${context.channel.slug}/children/${request.child.slug}).`,
	}]);
	await service.jobChanged(answer.job);
	expect(notices.map(value => value.id)).toEqual([
		`research-ready:${started.request.id}:${answer.job.id}`,
		`research-ready:${started.request.id}:${answer.job.id}`,
	]);
});
