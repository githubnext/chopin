import { describe, expect, test } from "bun:test";
import { Experiments } from "../experiments/service";
import { openedStorage, userAndChannel } from "./contract-support";
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
	});
}
