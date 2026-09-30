import { expect, it } from "bun:test";
import { contractId as id, openedStorage as opened, userAndChannel } from "./contract-support";
import type { StorageFactory as Factory } from "./contract-support";
import { researchWorkspace } from "./research-inline-contract-fixtures";

export function researchInlineContract6(factory: Factory): void {
	it("filters hidden Planner requests before workspace listing limits", async () => {
		let storage = await opened(factory);
		try {
			let { userId, channelId, repositoryId, lease } = await userAndChannel(storage);
			let sidebar = await storage.research.create(researchWorkspace(channelId, userId, lease));
			let later = new Date(sidebar.workspace.updatedAt.getTime() + 1000);
			await storage.research.start({
				id: id("hidden-planner-workspace"),
				channelId,
				title: "Hidden Planner request",
				question: "Research a release",
				origin: "planner",
				originMessageId: id("hidden-planner-origin"),
				inlineReference: "pending",
				createdBy: userId,
				turnId: id("hidden-planner-turn"),
				messageId: id("hidden-planner-message"),
				requestId: id("hidden-planner-request"),
				idempotencyKey: id("hidden-planner-start"),
				fingerprint: "sha256:hidden-planner-start",
				now: later,
				lease,
			});
			expect((await storage.research.list(channelId, 1, false)).map(value => value.id))
				.toEqual([sidebar.workspace.id]);
			let repository = await storage.research.listRepository(repositoryId, 1, false, false);
			expect(repository.channels.flatMap(group => group.workspaces.map(value => value.id)))
				.toContain(sidebar.workspace.id);
		} finally {
			await storage.close();
		}
	});
}
