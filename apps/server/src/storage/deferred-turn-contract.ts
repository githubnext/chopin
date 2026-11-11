import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";

/**
 * Rows an earlier release kept for Planner requests that waited are only closed now: with none
 * open, closing is a no-op, and only the holder of the writer lease may do it.
 */
export function deferredTurnContract(name: string, factory: StorageFactory) {
	describe(`${name} rows kept for Planner requests that waited`, () => {
		test("retiring with nothing open closes nothing, however often it runs", async () => {
			let storage = await openedStorage(factory);
			try {
				let { lease } = await userAndChannel(storage);
				expect(await storage.deferredTurns.retire(lease, new Date())).toBe(0);
				expect(await storage.deferredTurns.retire(lease, new Date())).toBe(0);
			} finally {
				await storage.close();
			}
		});

		test("refuses a writer lease that has been taken over", async () => {
			let storage = await openedStorage(factory);
			try {
				let name = id("writer");
				let first = (await storage.leases.acquire(name, "first", 60_000))!;
				await storage.leases.release(first);
				await storage.leases.acquire(name, "second", 60_000);
				let error = await storage.deferredTurns.retire(first, new Date()).then(
					() => undefined,
					err => err,
				);
				expect(error).toBeInstanceOf(StorageError);
				expect((error as StorageError).failure).toBe("conflict");
			} finally {
				await storage.close();
			}
		});
	});
}
