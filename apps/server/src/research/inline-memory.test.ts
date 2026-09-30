import { expect, it, spyOn } from "bun:test";

import { setup } from "./test-support";

it("recovers one durably committed reference after its placement marker fails", async () => {
	let context = await setup();
	let placements: Array<{ repeated: boolean }> = [];
	let placeReference = async (workspaceId: string) => {
		let saved = await context.storage.collaboration.load(context.channelId, context.advance());
		let committed = await context.storage.collaboration.commit({
			channelId: context.channelId,
			lease: context.lease,
			expectedRevision: saved!.channel.revision,
			operationId: `research-reference:${workspaceId}`,
			epoch: "research-test",
			sidecar: { researchReference: workspaceId },
			events: [],
			now: context.advance(),
		});
		placements.push(committed);
		return "placed" as const;
	};
	let mark = spyOn(context.storage.research, "markReferencePlaced").mockRejectedValueOnce(
		new Error("placement marker unavailable"),
	);
	try {
		await expect(context.service.startPlannerInline({
			channelId: context.channelId,
			question: "Which APIs changed?",
			originMessageId: "message-memory-recovery",
			requestedBy: context.userId,
			placeReference,
		})).rejects.toThrow("placement marker unavailable");
	} finally {
		mark.mockRestore();
	}
	let [pending] = await context.storage.research.listReferenceRecovery(100);
	expect(pending?.inlineReference).toBe("pending");
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toEqual([]);
	expect(context.publications).toEqual([]);
	expect((await context.storage.collaboration.load(context.channelId, context.advance()))?.sidecar)
		.toEqual({ researchReference: pending!.id });
	let restarted = context.restart();
	await restarted.recoverPendingPlannerInline((_channelId, id) => placeReference(id));
	await restarted.recoverPendingPlannerInline((_channelId, id) => placeReference(id));
	expect(placements.map(value => value.repeated)).toEqual([false, true]);
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toHaveLength(1);
	expect((await context.storage.research.get(context.channelId, pending!.id))?.workspace)
		.toMatchObject({ inlineReference: "placed" });
	expect(
		(await context.storage.collaboration.load(context.channelId, context.advance()))
			?.channel.revision,
	).toBe(1);
});

it("does not enqueue when live authorization fails after reference placement", async () => {
	let context = await setup();
	await expect(context.service.startPlannerInline({
		channelId: context.channelId,
		question: "Which APIs changed?",
		originMessageId: "message-owner-denied",
		requestedBy: context.userId,
		placeReference: async () => "placed",
		beforeStart: () => {
			throw new Error("active owner revoked");
		},
	})).rejects.toThrow("active owner revoked");
	let [pending] = await context.storage.research.listReferenceRecovery(100);
	expect(pending?.inlineReference).toBe("placed");
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toEqual([]);
	expect(context.publications).toEqual([]);
});

it("rejects a new inline request after its parent is archived", async () => {
	let context = await setup();
	await context.storage.channels.archive({ id: context.channelId, now: context.advance() });
	let placed = false;
	await expect(context.service.startPlannerInline({
		channelId: context.channelId,
		question: "Which APIs changed?",
		originMessageId: "message-archived-parent",
		requestedBy: context.userId,
		placeReference: async () => {
			placed = true;
			return "placed";
		},
	})).rejects.toMatchObject({ code: "invalid-request" });
	expect(placed).toBe(false);
	expect(await context.storage.research.list(context.channelId, 100)).toEqual([]);
});
