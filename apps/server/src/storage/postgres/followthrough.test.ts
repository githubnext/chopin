import { SQL } from "bun";
import { expect, test } from "bun:test";
import { contractId, userAndChannel } from "../contract-support";
import { PostgresStorage } from "./adapter";
import { enqueueFollowthrough } from "./followthrough";

let url = process.env.TEST_DATABASE_URL;

if (url) {
	test("receipts survive a new adapter, interrupt once, and cascade with evidence deletion", async () => {
		let first = new PostgresStorage(url);
		await first.migrate();
		let { channelId, repositoryId, userId, lease } = await userAndChannel(first);
		let child = await first.channels.create({
			id: contractId("receipt-child"),
			repositoryId,
			repositoryOwner: "octo",
			repositoryName: "repo",
			parentChannelId: channelId,
			title: "Evidence",
			createdBy: userId,
			now: new Date(),
		});
		let sql = new SQL(url);
		try {
			await sql.begin(transaction =>
				enqueueFollowthrough(transaction, {
					channelId,
					childId: child.id,
					kind: "research",
					sourceId: "fixture",
					resultKey: "answer",
					now: new Date(),
				})
			);
			let [pending] = await first.followthrough.pending(channelId, 10);
			let claimed = await first.followthrough.claim(channelId, pending!.id, 0, {
				planRevision: 7,
				sourceHash: "hash",
			}, lease);
			expect(claimed?.context).toEqual({ planRevision: 7, sourceHash: "hash" });
			await first.close();
			let second = new PostgresStorage(url);
			try {
				expect(await second.followthrough.get(channelId, pending!.id)).toEqual(claimed!);
				expect((await second.followthrough.get(channelId, pending!.id))?.context)
					.toEqual({ planRevision: 7, sourceHash: "hash" });
				expect(await second.followthrough.recoverInterrupted(lease)).toBe(1);
				expect(await second.followthrough.recoverInterrupted(lease)).toBe(0);
				expect(await second.followthrough.get(channelId, pending!.id)).toMatchObject({
					status: "failed",
					reason: "interrupted",
					revision: 2,
				});
				await second.channels.archive({ id: child.id, now: new Date() });
				expect(await second.channels.delete(child.id)).toBe(true);
				expect(await second.followthrough.get(channelId, pending!.id)).toBeUndefined();
				await second.channels.archive({ id: channelId, now: new Date() });
				expect(await second.channels.delete(channelId)).toBe(true);
			} finally {
				await second.close();
			}
		} finally {
			await first.close();
			await sql.close();
		}
	});
}
