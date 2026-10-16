import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";

import type { StorageFactory } from "./contract-support";

const MINUTE = 60_000;

export function versionContract(name: string, factory: StorageFactory) {
	describe(`${name} document versions`, () => {
		test("extends one author's session until they pause or someone else edits", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let at = (minutes: number) => new Date(Date.UTC(2026, 0, 2, 3, minutes));
				let record = (
					revision: number,
					minutes: number,
					authorId?: string,
				) =>
					storage.versions.record({
						channelId,
						...(authorId ? { authorId } : {}),
						revision,
						source: `# Plan ${revision}\n`,
						sourceHash: `hash-${revision}`,
						now: at(minutes),
						idleMs: 10 * MINUTE,
					});

				let first = await record(1, 0, userId);
				let extended = await record(2, 5, userId);
				expect(extended?.id).toBe(first?.id);
				expect(extended?.startedAt).toEqual(at(0));
				expect(extended?.updatedAt).toEqual(at(5));

				let chopin = await record(3, 6);
				expect(chopin?.id).not.toBe(first?.id);
				expect(chopin?.authorId).toBeUndefined();
				let paused = await record(4, 30, userId);
				expect(paused?.id).not.toBe(first?.id);
				// The same source as the latest session records nothing.
				expect(await record(4, 31, userId)).toBeUndefined();

				let listed = await storage.versions.list(channelId, 10);
				expect(listed.map(version => version.revision)).toEqual([4, 3, 2]);
				expect(listed[0]).toMatchObject({ authorId: userId, authorLogin: "octocat" });
				expect(await storage.versions.list(channelId, 1)).toHaveLength(1);

				let stored = await storage.versions.get(channelId, first!.id);
				expect(stored).toMatchObject({ revision: 2, source: "# Plan 2\n" });
				expect(await storage.versions.get(id("channel"), first!.id)).toBeUndefined();

				expect(await storage.versions.previous(channelId, paused!.id)).toMatchObject({
					id: chopin!.id,
					source: "# Plan 3\n",
				});
				expect(await storage.versions.previous(channelId, first!.id)).toBeUndefined();

				// A summary sticks to the source it describes and lapses when the session moves on.
				expect(
					await storage.versions.summarize({
						channelId,
						id: paused!.id,
						sourceHash: "hash-stale",
						summary: "Never stored",
					}),
				).toBe(false);
				expect(
					await storage.versions.summarize({
						channelId,
						id: paused!.id,
						sourceHash: "hash-4",
						summary: "Rewrote the plan",
					}),
				).toBe(true);
				expect((await storage.versions.list(channelId, 1))[0]?.summary).toBe("Rewrote the plan");
				await record(5, 32, userId);
				expect((await storage.versions.list(channelId, 1))[0]?.summary).toBeUndefined();
			} finally {
				await storage.close();
			}
		});
	});
}
