import { expect, test } from "bun:test";
import { contractId, userAndChannel } from "../contract-support";
import { MemoryStorage } from "./adapter";

test("channel deletion removes receipts permanently, including after identity reuse", async () => {
	let storage = new MemoryStorage();
	let { channelId, repositoryId, userId, lease } = await userAndChannel(storage);
	let input = {
		id: contractId("receipt-child"),
		repositoryId,
		repositoryOwner: "octo",
		repositoryName: "repo",
		parentChannelId: channelId,
		title: "Evidence",
		createdBy: userId,
		now: new Date(),
	};
	await storage.channels.create(input);
	storage.followthrough.prepare({
		channelId,
		childId: input.id,
		kind: "research",
		sourceId: "source",
		resultKey: "answer",
		now: new Date(),
	})();
	let [receipt] = await storage.followthrough.pending(channelId, 10);
	expect(receipt).toBeDefined();
	await storage.channels.archive({ id: input.id, now: new Date() });
	expect(await storage.channels.delete(input.id)).toBe(true);
	expect(await storage.followthrough.get(channelId, receipt!.id)).toBeUndefined();
	await storage.channels.create(input);
	expect(await storage.followthrough.forSource(channelId, "research", "source")).toEqual([]);
	expect(
		await storage.followthrough.claim(channelId, receipt!.id, 0, {
			planRevision: 0,
			sourceHash: "hash",
		}, lease),
	).toBeUndefined();
	await storage.channels.archive({ id: input.id, now: new Date() });
	await storage.channels.delete(input.id);
	await storage.channels.archive({ id: channelId, now: new Date() });
	expect(await storage.channels.delete(channelId)).toBe(true);
	expect(await storage.followthrough.pending(undefined, 100)).toEqual([]);
});
