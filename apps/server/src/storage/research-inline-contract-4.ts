import { expect, it } from "bun:test";
import { contractId as id, openedStorage as opened, userAndChannel } from "./contract-support";
import type { StorageFactory as Factory } from "./contract-support";

export function researchInlineContract4(factory: Factory): void {
	it("finds a Planner request by its channel-scoped durable key", async () => {
		let storage = await opened(factory);
		try {
			let { userId, channelId, repositoryId, lease } = await userAndChannel(storage);
			let input = {
				id: id("lookup-workspace"),
				channelId,
				title: "Lookup research",
				question: "Which API contracts changed?",
				origin: "planner" as const,
				originMessageId: id("lookup-origin"),
				inlineReference: "pending" as const,
				createdBy: userId,
				createdByHandle: "octocat",
				turnId: id("lookup-turn"),
				messageId: id("lookup-message"),
				requestId: id("lookup-request"),
				idempotencyKey: id("lookup-key"),
				fingerprint: "sha256:lookup-fingerprint",
				now: new Date("2026-01-07T03:04:05.000Z"),
				lease,
			};
			await storage.research.start(input);
			let other = await storage.channels.create({
				id: id("other-channel"),
				repositoryId,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Other document",
				createdBy: userId,
				now: input.now,
			});
			expect(await storage.research.findByIdempotencyKey(channelId, input.idempotencyKey))
				.toEqual(await storage.research.get(channelId, input.id));
			expect(await storage.research.findByIdempotencyKey(channelId, "missing"))
				.toBeUndefined();
			expect(await storage.research.findByIdempotencyKey(other.id, input.idempotencyKey))
				.toBeUndefined();
			await storage.research.markReferencePlaced({ channelId, workspaceId: input.id, lease });
			expect(
				(await storage.research.findByIdempotencyKey(channelId, input.idempotencyKey))
					?.workspace.inlineReference,
			).toBe("placed");
		} finally {
			await storage.close();
		}
	});
}
