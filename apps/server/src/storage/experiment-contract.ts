import { describe, expect, test } from "bun:test";
import { performance } from "@chopin/experiment/fixtures";
import { Experiments } from "../experiments/service";
import { contractId, openedStorage, userAndChannel } from "./contract-support";
import type { StorageFactory } from "./contract-support";

export function experimentContract(name: string, factory: StorageFactory) {
	describe(`${name} experiments`, () => {
		test("fences writes, compares revisions and retains committed snapshots", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId, lease } = await userAndChannel(storage);
				let service = new Experiments(storage.experiments, () => lease);
				let value = await service.create(channelId, userId, "Measure startup");
				expect(await storage.experiments.get(value.id)).toEqual(value);
				let next = { ...value, revision: 1, progress: "working" };
				expect(await storage.experiments.save(next, 0, lease)).toBe(true);
				expect(await storage.experiments.save({ ...next, progress: "stale" }, 0, lease)).toBe(
					false,
				);
				expect((await storage.experiments.get(value.id))?.progress).toBe("working");
				next.progress = "external mutation";
				expect((await storage.experiments.get(value.id))?.progress).toBe("working");
				await expect(
					storage.experiments.save({ ...next, revision: 2 }, 1, { ...lease, owner: "wrong" }),
				).rejects.toThrow();
			} finally {
				await storage.close();
			}
		});
		test("publishes a completed investigation as one child document, idempotently", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId, lease } = await userAndChannel(storage);
				let service = new Experiments(storage.experiments, () => lease);
				let created = await service.create(channelId, userId, "Does caching help startup?");
				let publishing = {
					...created,
					revision: 1,
					state: "publishing" as const,
					connectionId: "connection",
					generation: 1,
					expiresAt: Date.now() + 60_000,
					candidate: performance,
				};
				expect(await storage.experiments.save(publishing, 0, lease)).toBe(true);
				let [first, second] = await Promise.all([
					service.complete(created.id, "connection", 1),
					service.complete(created.id, "connection", 1),
				]);
				expect(first.state).toBe("completed");
				expect(first.childId).toBeDefined();
				expect(second.childId).toBe(first.childId);
				expect(first.result).toEqual(performance);
				expect(first.candidate).toBeUndefined();
				let child = await storage.channels.get(first.childId!);
				expect(child).toMatchObject({ parentChannelId: channelId, title: "Startup comparison" });
				let loaded = await storage.collaboration.load(first.childId!, new Date());
				expect(loaded?.snapshot?.source).toContain(`experiment="${created.id}"`);
				expect((await storage.experiments.published(first.childId!))?.id).toBe(created.id);
				expect(await storage.experiments.published(channelId)).toBeUndefined();
				let stored = await storage.experiments.get(created.id);
				expect(
					await storage.experiments.publish(
						{ ...stored!, revision: stored!.revision + 1 },
						stored!.revision,
						{ title: "Again", initial: loaded?.snapshot as never, now: new Date() },
						lease,
					),
				).toEqual(stored!);
				await storage.channels.archive({ id: first.childId!, now: new Date() });
				await expect(storage.channels.delete(first.childId!)).rejects.toMatchObject({
					failure: "conflict",
					message: expect.stringContaining("published by an investigation"),
				});
				expect(await storage.channels.get(first.childId!)).toBeDefined();
			} finally {
				await storage.close();
			}
		});
		test("refuses to publish an investigation held by a child document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, repositoryId, userId, lease } = await userAndChannel(storage);
				let childId = contractId("channel");
				await storage.channels.create({
					id: childId,
					repositoryId,
					repositoryOwner: "octo",
					repositoryName: "repo",
					parentChannelId: channelId,
					title: "Child",
					createdBy: userId,
					now: new Date("2026-01-02T03:04:05.000Z"),
				});
				let service = new Experiments(storage.experiments, () => lease);
				let created = await service.create(childId, userId, "Does caching help startup?");
				let completed = {
					...created,
					revision: 1,
					state: "completed" as const,
					result: performance,
				};
				await expect(
					storage.experiments.publish(
						completed,
						0,
						{ title: "Nested", initial: undefined as never, now: new Date() },
						lease,
					),
				).rejects.toMatchObject({ failure: "conflict" });
				expect((await storage.experiments.get(created.id))?.childId).toBeUndefined();
			} finally {
				await storage.close();
			}
		});
	});
}
