import { expect, it } from "bun:test";
import { contractId as id, openedStorage as opened, userAndChannel } from "./contract-support";
import type { StorageFactory as Factory } from "./contract-support";

export function researchInlineContract3(factory: Factory): void {
	it("retains Planner inline placement recovery through exact retries", async () => {
		let storage = await opened(factory);
		try {
			let { userId, channelId, lease } = await userAndChannel(storage);
			let input = {
				id: id("planner-inline-workspace"),
				channelId,
				title: "Planner inline research",
				question: "Which API contracts changed?",
				origin: "planner" as const,
				originMessageId: id("planner-inline-origin"),
				inlineReference: "pending" as const,
				createdBy: userId,
				turnId: id("planner-inline-turn"),
				messageId: id("planner-inline-message"),
				requestId: id("planner-inline-request"),
				idempotencyKey: id("planner-inline-start"),
				fingerprint: "sha256:planner-inline-start",
				now: new Date("2026-01-07T03:04:05.000Z"),
				lease,
			};
			let started = await storage.research.start(input);
			expect(started.workspace.inlineReference).toBe("pending");
			expect((await storage.research.listReferenceRecovery(100)).map(value => value.id))
				.toContain(input.id);
			await storage.research.markReferencePlaced({ channelId, workspaceId: input.id, lease });
			await storage.research.markReferencePlaced({ channelId, workspaceId: input.id, lease });
			expect((await storage.research.get(channelId, input.id))?.workspace.inlineReference)
				.toBe("placed");
			expect((await storage.research.listReferenceRecovery(100)).map(value => value.id))
				.toContain(input.id);
			let repeated = await storage.research.start(input);
			expect(repeated.workspace.inlineReference).toBe("placed");
			expect(repeated.repeated).toBe(true);
		} finally {
			await storage.close();
		}
	});
}
