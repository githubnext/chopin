import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage } from "./contract-support";

import type { StorageFactory } from "./contract-support";

export function leasePeekContract(name: string, factory: StorageFactory) {
	describe(`${name} lease peek`, () => {
		test("reads a lease without taking, renewing or changing it", async () => {
			let storage = await openedStorage(factory);
			try {
				let lease = id("lease");
				expect(await storage.leases.peek(lease)).toBeUndefined();
				// Reading a lease that was never taken does not create it.
				expect(await storage.leases.peek(lease)).toBeUndefined();

				let held = (await storage.leases.acquire(lease, "first", 60_000))!;
				let peeked = (await storage.leases.peek(lease))!;
				expect(peeked.free).toBe(false);
				expect(peeked.lease).toMatchObject({ name: lease, owner: "first", fencing: held.fencing });
				expect(peeked.lease.expiresAt.getTime()).toBe(held.expiresAt.getTime());
				// It neither renewed the lease nor made it available to anyone else.
				expect(await storage.leases.acquire(lease, "second", 60_000)).toBeUndefined();
				expect((await storage.leases.peek(lease))!.lease.expiresAt.getTime()).toBe(
					held.expiresAt.getTime(),
				);
			} finally {
				await storage.close();
			}
		});

		test("shows a released or expired lease as free, with the fencing token the next holder passes", async () => {
			let storage = await openedStorage(factory);
			try {
				let released = id("released");
				let first = (await storage.leases.acquire(released, "first", 60_000))!;
				expect(await storage.leases.release(first)).toBe(true);
				let peeked = (await storage.leases.peek(released))!;
				expect(peeked.free).toBe(true);
				expect(peeked.lease).toMatchObject({ owner: "first", fencing: first.fencing });
				let second = (await storage.leases.acquire(released, "second", 60_000))!;
				expect(second.fencing).toBe(first.fencing + 1);
				expect((await storage.leases.peek(released))!.free).toBe(false);

				// Both are read after the same wait, so neither depends on how soon after it was taken a
				// read lands: a database slower than the short lease's time would otherwise find it free.
				let expiring = id("expiring");
				let lasting = id("lasting");
				await storage.leases.acquire(expiring, "first", 20);
				await storage.leases.acquire(lasting, "first", 60_000);
				await Bun.sleep(60);
				expect((await storage.leases.peek(expiring))!.free).toBe(true);
				expect((await storage.leases.peek(lasting))!.free).toBe(false);
			} finally {
				await storage.close();
			}
		});
	});
}
