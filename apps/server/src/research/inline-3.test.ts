import { expect, it } from "bun:test";
import { setup } from "./test-support";

it("retries a failed inline placement without publishing or enqueuing early", async () => {
	let context = await setup();
	let placed = false;
	let input = {
		channelId: context.channelId,
		question: "Which public evidence supports version 3?",
		originMessageId: "01K39QZG000000000000000004",
		requestedBy: context.userId,
		placeReference: async () => {
			if (!placed) throw new Error("document commit failed");
			return "placed" as const;
		},
	};
	await expect(context.service.startPlannerInline(input)).rejects.toThrow(
		"document commit failed",
	);
	expect(context.publications).toEqual([]);
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toEqual([]);
	let [durable] = await context.storage.research.list(context.channelId, 100);
	expect(durable?.origin).toBe("planner");
	placed = true;
	await context.restart().recoverPendingPlannerInline(async (channelId, id) => {
		expect(channelId).toBe(context.channelId);
		expect(id).toBe(durable?.id);
		return "placed";
	});
	expect(
		(await context.storage.research.get(context.channelId, durable!.id))?.workspace
			.inlineReference,
	).toBe("placed");
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toHaveLength(1);
	let retry = await context.restart().startPlannerInline(input);
	expect(retry.repeated).toBe(true);
	expect(retry.request.stage).toBe("queued");
	expect(retry.request.id).toBe(durable?.id);
});

it("recovers after the card commit but before the placement marker advances", async () => {
	let context = await setup();
	let references = new Set<string>();
	let placed = context.storage.research.markReferencePlaced;
	let interrupted = true;
	context.storage.research.markReferencePlaced = async input => {
		if (interrupted) throw new Error("crash after document commit");
		return placed(input);
	};
	let input = {
		channelId: context.channelId,
		question: "Which API contracts changed?",
		originMessageId: "01K39QZG000000000000000007",
		requestedBy: context.userId,
		placeReference: async (id: string) => {
			references.add(id);
			return "placed" as const;
		},
	};
	await expect(context.service.startPlannerInline(input))
		.rejects.toThrow("crash after document commit");
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toEqual([]);
	interrupted = false;
	await context.restart().recoverPendingPlannerInline(async (_channelId, id) => {
		references.add(id);
		return "placed";
	});
	expect(references.size).toBe(1);
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toHaveLength(1);
});

it("defers an implementation-locked card and recovers other requests", async () => {
	let context = await setup();
	let ids: string[] = [];
	for (let suffix of ["a", "b"]) {
		await expect(context.service.startPlannerInline({
			channelId: context.channelId,
			question: `Research brief ${suffix}`,
			originMessageId: `01K39QZG00000000000000000${suffix}`,
			requestedBy: context.userId,
			placeReference: async id => {
				ids.push(id);
				return "deferred";
			},
		})).rejects.toMatchObject({ code: "not-ready" });
	}
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toEqual([]);
	let locked = ids[0]!;
	let result = await context.restart().recoverPendingPlannerInline(async (_channelId, id) =>
		id === locked ? "deferred" : "placed"
	);
	expect(result).toEqual({ deferred: 1 });
	expect(
		(await context.storage.research.get(context.channelId, locked))?.workspace
			.inlineReference,
	).toBe("pending");
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toHaveLength(1);
	let resumed = await context.restart().recoverPendingPlannerInline(async () => "placed");
	expect(resumed).toEqual({ deferred: 0 });
	expect(
		(await context.storage.research.get(context.channelId, locked))?.workspace
			.inlineReference,
	).toBe("placed");
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toHaveLength(2);
});

it("places pending cards when research execution is temporarily disabled", async () => {
	let context = await setup({ answer: false });
	let saved = await context.storage.research.start({
		id: "disabled-research",
		channelId: context.channelId,
		title: "Disabled research",
		question: "Which API contracts changed?",
		origin: "planner",
		originMessageId: "01K39QZG000000000000000008",
		inlineReference: "pending",
		createdBy: context.userId,
		turnId: "disabled-turn",
		messageId: "disabled-message",
		requestId: "disabled-request",
		idempotencyKey: "disabled-research",
		fingerprint: "disabled-research",
		now: context.advance(),
		lease: context.lease,
	});
	let placed: string[] = [];
	await context.service.recoverPendingPlannerInline(async (_channelId, id) => {
		placed.push(id);
		return "placed";
	}, context.channelId);
	expect(placed).toEqual([saved.workspace.id]);
	expect(
		(await context.storage.research.get(context.channelId, saved.workspace.id))
			?.workspace.inlineReference,
	).toBe("placed");
	expect((await context.jobs.list(context.channelId, 100))?.jobs).toEqual([]);
	expect((await context.storage.research.listReferenceRecovery(100)).map(value => value.id))
		.toContain(saved.workspace.id);
});
