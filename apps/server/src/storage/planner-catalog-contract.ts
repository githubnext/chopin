import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, testLease, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";

const AT = new Date("2026-01-03T03:04:05.000Z");
const LATER = new Date("2026-01-03T04:05:06.000Z");

const LARGE = {
	models: [{
		id: "acme/large",
		name: "Large",
		provider: { id: "acme", name: "Acme" },
		thinkingLevels: ["low", "high"],
		inputTypes: ["text", "image"],
	}],
	default: { model: "acme/large", thinkingLevel: "high" },
};
const SMALL = { models: [{ id: "acme/small", name: "Small" }] };

export function plannerCatalogContract(name: string, factory: StorageFactory) {
	describe(`${name} Planner model lists`, () => {
		test("keeps one list per document and account, replaced whole", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let other = id("user");
				await storage.users.put({ id: other, login: "hubot", avatarUrl: "", now: AT });
				expect(await storage.plannerCatalogs.get(channelId, userId)).toBeUndefined();

				await storage.plannerCatalogs.put(lease, {
					channelId,
					userId,
					catalog: LARGE,
					reportedAt: AT,
				});
				expect(await storage.plannerCatalogs.get(channelId, userId)).toEqual({
					channelId,
					userId,
					catalog: LARGE,
					reportedAt: AT,
				});
				// Another account's list is its own, and reading one account never finds the other's.
				expect(await storage.plannerCatalogs.get(channelId, other)).toBeUndefined();
				await storage.plannerCatalogs.put(lease, {
					channelId,
					userId: other,
					catalog: SMALL,
					reportedAt: AT,
				});
				await storage.plannerCatalogs.put(lease, {
					channelId,
					userId,
					catalog: SMALL,
					reportedAt: LATER,
				});
				expect(await storage.plannerCatalogs.get(channelId, userId)).toEqual({
					channelId,
					userId,
					catalog: SMALL,
					reportedAt: LATER,
				});
				expect((await storage.plannerCatalogs.get(channelId, other))?.catalog).toEqual(SMALL);
			} finally {
				await storage.close();
			}
		});

		test("refuses an unknown document or account, and a writer that lost the lease", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let row = { channelId, userId, catalog: LARGE, reportedAt: AT };
				for (let bad of [{ ...row, channelId: id("channel") }, { ...row, userId: id("user") }]) {
					let error = await storage.plannerCatalogs.put(lease, bad).then(
						() => undefined,
						err => err,
					);
					expect(error).toBeInstanceOf(StorageError);
				}
				await storage.leases.release(lease);
				let stale = await storage.plannerCatalogs.put(lease, row).then(
					() => undefined,
					err => err,
				);
				expect(stale).toBeInstanceOf(StorageError);
				expect(await storage.plannerCatalogs.get(channelId, userId)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("goes with its document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				await storage.plannerCatalogs.put(lease, {
					channelId,
					userId,
					catalog: LARGE,
					reportedAt: AT,
				});
				await storage.channels.archive({ id: channelId, now: AT, lease: await testLease(storage) });
				await storage.channels.delete(channelId);
				expect(await storage.plannerCatalogs.get(channelId, userId)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});
	});
}
