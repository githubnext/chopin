import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, testLease, userAndChannel } from "./contract-support";

import type { StorageFactory } from "./contract-support";

export function createdFromContract(name: string, factory: StorageFactory) {
	describe(`${name} documents created from a document`, () => {
		test("links each to the document it was created from and lists them oldest first", async () => {
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
					id: id("later"),
					title: "Checkout",
					createdFrom: channelId,
					now: new Date("2026-01-03T00:00:00.000Z"),
				});
				let earlier = await storage.channels.create({
					...fields,
					id: id("earlier"),
					title: "Login",
					createdFrom: channelId,
					now: new Date("2026-01-02T12:00:00.000Z"),
				});
				let unrelated = await storage.channels.create({
					...fields,
					id: id("unrelated"),
					title: "Unrelated",
					now: new Date("2026-01-02T13:00:00.000Z"),
				});
				expect(later.createdFrom).toBe(channelId);
				expect((await storage.channels.get(earlier.id))!.createdFrom).toBe(channelId);
				expect(unrelated.createdFrom).toBeUndefined();
				expect((await storage.channels.createdFrom(channelId, 10)).map(item => item.title))
					.toEqual(["Login", "Checkout"]);
				expect((await storage.channels.createdFrom(channelId, 1)).map(item => item.title))
					.toEqual(["Login"]);

				await storage.channels.archive({
					id: earlier.id,
					now: new Date("2026-01-04T00:00:00.000Z"),
					lease: await testLease(storage),
				});
				expect((await storage.channels.createdFrom(channelId, 10)).map(item => item.title))
					.toEqual(["Checkout"]);
			} finally {
				await storage.close();
			}
		});

		test("refuses a link to a document of another repository or one that does not exist", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId } = await userAndChannel(storage);
				let fields = {
					repositoryOwner: "octo-org",
					repositoryName: "other",
					createdBy: userId,
					now: new Date("2026-01-03T00:00:00.000Z"),
				};
				await expect(storage.channels.create({
					...fields,
					id: id("elsewhere"),
					repositoryId: id("repository"),
					title: "Elsewhere",
					createdFrom: channelId,
				})).rejects.toMatchObject({ failure: "conflict" });
				await expect(storage.channels.create({
					...fields,
					id: id("orphan"),
					repositoryId: id("repository"),
					title: "Orphan",
					createdFrom: id("missing"),
				})).rejects.toMatchObject({ failure: "missing" });
			} finally {
				await storage.close();
			}
		});

		test("keeps the documents a deleted document created, unlinked", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, repositoryId } = await userAndChannel(storage);
				let created = await storage.channels.create({
					id: id("created"),
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Checkout",
					createdBy: userId,
					createdFrom: channelId,
					now: new Date("2026-01-03T00:00:00.000Z"),
				});
				await storage.channels.delete({ id: channelId, lease: await testLease(storage) });
				let kept = await storage.channels.get(created.id);
				expect(kept?.title).toBe("Checkout");
				expect(kept?.createdFrom).toBeUndefined();
				expect(await storage.channels.createdFrom(channelId, 10)).toEqual([]);
			} finally {
				await storage.close();
			}
		});
	});
}
