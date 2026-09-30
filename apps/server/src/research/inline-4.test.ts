import { expect, it } from "bun:test";
import { ResearchWorkspaceError } from "./service";
import {
	answerArtifact,
	createChild,
	evidenceArtifact,
	reconciledRequest,
	REPORT,
	REPOSITORY_ID,
	settle,
	setup,
} from "./test-support";
import { childFixture, failInitialEvidence } from "./inline.test-fixtures";

it("refuses inline Planner research for an absent or child channel", async () => {
	let context = await setup();
	let child = await createChild(childFixture(context));
	let placements = 0;
	for (let channelId of ["missing-channel", child.id]) {
		await expect(context.service.startPlannerInline({
			channelId,
			question: "Create a child report",
			originMessageId: "01K39QZG000000000000000005",
			requestedBy: context.userId,
			placeReference: async () => {
				placements++;
				return "placed";
			},
		})).rejects.toBeInstanceOf(ResearchWorkspaceError);
		expect(await context.storage.research.list(channelId, 100)).toEqual([]);
	}
	expect(placements).toBe(0);
});

it("keeps a Planner card linked through failure, retry, and child publication", async () => {
	let context = await setup();
	let references = new Set<string>();
	let input = {
		channelId: context.channelId,
		question: "Which API contracts changed?",
		originMessageId: "01K39QZG000000000000000006",
		requestedBy: context.userId,
		placeReference: async (id: string) => {
			references.add(id);
			return "placed" as const;
		},
	};
	let started = await context.service.startPlannerInline(input);
	await failInitialEvidence(context);
	expect(await context.service.request(context.channelId, started.request.id))
		.toMatchObject({ stage: "failed" });
	await context.service.retryRequest({
		channelId: context.channelId,
		workspaceId: started.request.id,
	});
	await settle(context, "research-evidence", evidenceArtifact);
	await reconciledRequest(context.service, context.channelId, started.request.id);
	await settle(context, "research-answer", answerArtifact);
	let ready = await reconciledRequest(context.service, context.channelId, started.request.id);
	expect(ready).toMatchObject({ stage: "ready", child: { title: REPORT.title } });
	expect(references).toEqual(new Set([started.request.id]));
	expect((await context.storage.channels.list(REPOSITORY_ID, 100)).channels
		.filter(channel => channel.parentChannelId === context.channelId)).toHaveLength(1);
});
