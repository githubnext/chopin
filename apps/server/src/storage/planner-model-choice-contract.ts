import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";

const AT = new Date("2026-01-03T03:04:05.000Z");

export function plannerModelChoiceContract(name: string, factory: StorageFactory) {
	describe(`${name} Planner model choices`, () => {
		test("keeps one choice per document, replaces it whole and clears it when empty", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				expect(await storage.plannerModelChoices.get(channelId)).toBeUndefined();

				let first = {
					channelId,
					model: "acme/large:preview",
					modelName: "Large",
					thinkingLevel: "high",
					userId,
					updatedAt: AT,
				};
				await storage.plannerModelChoices.put(lease, first);
				expect(await storage.plannerModelChoices.get(channelId)).toEqual(first);

				// A level alone is a choice too: the default model, another level.
				let level = {
					channelId,
					thinkingLevel: "xhigh",
					userId,
					updatedAt: new Date(AT.getTime() + 1_000),
				};
				await storage.plannerModelChoices.put(lease, level);
				expect(await storage.plannerModelChoices.get(channelId)).toEqual(level);

				let found = (await storage.plannerModelChoices.get(channelId))!;
				found.updatedAt.setTime(0);
				expect((await storage.plannerModelChoices.get(channelId))!.updatedAt).toEqual(
					level.updatedAt,
				);

				await storage.plannerModelChoices.put(lease, { channelId, userId, updatedAt: AT });
				expect(await storage.plannerModelChoices.get(channelId)).toBeUndefined();
				// Clearing what is not there is not an error.
				await storage.plannerModelChoices.put(lease, { channelId, userId, updatedAt: AT });
			} finally {
				await storage.close();
			}
		});

		test("keeps a model and a level exactly as written, whatever their spelling or length", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				// The catalog a harness reports is not bounded, so a person can choose what it lists.
				for (
					let [model, thinkingLevel] of [
						[`acme/${"m".repeat(5_000)}`, "extra high"],
						['with space \n and "quotes"', "\u4f4e"],
						["", ""],
						["acme/small", "x".repeat(10_000)],
					] as const
				) {
					let choice = { channelId, model, thinkingLevel, userId, updatedAt: AT };
					await storage.plannerModelChoices.put(lease, choice);
					expect(await storage.plannerModelChoices.get(channelId)).toEqual(choice);
				}
			} finally {
				await storage.close();
			}
		});

		test("refuses a choice for a document or a person that does not exist, and a stale writer", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let choice = { channelId, model: "acme/large", userId, updatedAt: AT };
				for (
					let bad of [{ ...choice, channelId: id("channel") }, { ...choice, userId: id("user") }]
				) {
					let error = await storage.plannerModelChoices.put(lease, bad).then(
						() => undefined,
						err => err,
					);
					expect(error).toBeInstanceOf(StorageError);
				}
				expect(await storage.plannerModelChoices.get(channelId)).toBeUndefined();
				await storage.leases.release(lease);
				let stale = await storage.plannerModelChoices.put(lease, choice).then(
					() => undefined,
					err => err,
				);
				expect(stale).toBeInstanceOf(StorageError);
				expect(await storage.plannerModelChoices.get(channelId)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("goes with its document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				await storage.plannerModelChoices.put(lease, {
					channelId,
					model: "acme/large",
					userId,
					updatedAt: AT,
				});
				await storage.channels.archive({ id: channelId, now: AT });
				await storage.channels.delete(channelId);
				expect(await storage.plannerModelChoices.get(channelId)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});
	});
}
