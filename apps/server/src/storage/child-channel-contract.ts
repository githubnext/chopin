import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";

import type { StorageFactory } from "./contract-support";

export function childChannelContract(name: string, factory: StorageFactory) {
	describe(`${name} child channels`, () => {
		test("lists only a parent's own unarchived children, oldest first and bounded", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, repositoryId } = await userAndChannel(storage);
				let fields = {
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					createdBy: userId,
				};
				let later = await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Later ${id("c")}`,
					parentChannelId: channelId,
					now: new Date("2026-01-03T05:00:00.000Z"),
				});
				let earlier = await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Earlier ${id("c")}`,
					parentChannelId: channelId,
					now: new Date("2026-01-03T04:00:00.000Z"),
				});
				let archived = await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Archived ${id("c")}`,
					parentChannelId: channelId,
					now: new Date("2026-01-03T03:00:00.000Z"),
				});
				await storage.channels.archive({
					id: archived.id,
					now: new Date("2026-01-03T06:00:00.000Z"),
				});
				let otherRoot = await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Other root ${id("c")}`,
					now: new Date("2026-01-03T03:30:00.000Z"),
				});
				await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Other child ${id("c")}`,
					parentChannelId: otherRoot.id,
					now: new Date("2026-01-03T03:40:00.000Z"),
				});

				let listed = await storage.channels.children(channelId, 10);
				expect(listed.map(child => child.id)).toEqual([earlier.id, later.id]);
				expect(listed.every(child => child.parentChannelId === channelId)).toBe(true);
				expect((await storage.channels.children(channelId, 1)).map(child => child.id))
					.toEqual([earlier.id]);
				expect(await storage.channels.children(earlier.id, 10)).toEqual([]);
				expect(await storage.channels.children(crypto.randomUUID(), 10)).toEqual([]);
			} finally {
				await storage.close();
			}
		});
	});
}
