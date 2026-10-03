import { expect, it } from "bun:test";
import { contractId as id, openedStorage as opened, userAndChannel } from "./contract-support";
import type { StorageFactory as Factory } from "./contract-support";

export function researchInlineContract2(factory: Factory): void {
	it("allows removing a legacy unlinked Research reference", async () => {
		let storage = await opened(factory);
		try {
			let { channelId, userId, lease } = await userAndChannel(storage);
			let now = new Date("2026-01-07T03:04:05.000Z");
			let workspaceId = id("legacy-inline-research");
			await storage.research.start({
				id: workspaceId,
				channelId,
				title: "Legacy inline research",
				question: "What changed?",
				origin: "inline",
				createdBy: userId,
				turnId: id("legacy-initial-turn"),
				messageId: id("legacy-initial-message"),
				requestId: id("legacy-initial-request"),
				idempotencyKey: id("legacy-inline-start"),
				fingerprint: id("legacy-inline-fingerprint"),
				now,
				lease,
			});
			let base = {
				channelId,
				lease,
				expectedRevision: 0,
				operationId: id("legacy-removal"),
				epoch: "legacy-epoch",
				update: new Uint8Array([1]),
				events: [],
				now,
			};
			await expect(storage.collaboration.commit({
				...base,
				researchProjections: [{ id: workspaceId, action: "add" }],
			})).rejects.toMatchObject({ failure: "conflict" });
			expect(
				await storage.collaboration.commit({
					...base,
					researchProjections: [{ id: workspaceId, action: "remove" }],
				}),
			).toMatchObject({ revision: 1 });
		} finally {
			await storage.close();
		}
	});
}
