import { describe, expect, it } from "bun:test";

import { contractId as id, openedStorage } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";
import type { CreateMachine } from "./model";
import type { StorageAdapter } from "./port";

function bytes(length: number, fill = Math.floor(Math.random() * 256)): Uint8Array {
	let value = new Uint8Array(length);
	crypto.getRandomValues(value);
	value[0] = fill;
	return value;
}

async function owner(storage: StorageAdapter) {
	let userId = id("machine-owner");
	await storage.users.put({
		id: userId,
		login: "mona",
		avatarUrl: "https://example.test/mona",
		now: new Date("2026-01-02T03:04:05.000Z"),
	});
	return userId;
}

function machine(userId: string, overrides: Partial<CreateMachine> = {}): CreateMachine {
	let now = new Date("2026-01-02T03:04:05.000Z");
	return {
		id: id("machine"),
		userId,
		label: "laptop",
		repositories: [{
			repositoryId: id("repository"),
			repository: "octo-org/score",
			commit: "a".repeat(40),
			branch: "main",
		}],
		autoRun: true,
		tokenHash: bytes(32),
		credentials: { ciphertext: bytes(48, 1), revision: 1 },
		createdAt: now,
		lastSeenAt: now,
		...overrides,
	};
}

export function machineContract(name: string, factory: StorageFactory) {
	describe(`${name} machines`, () => {
		it("keeps a paired machine, found by its token hash", async () => {
			let storage = await openedStorage(factory);
			try {
				let userId = await owner(storage);
				let input = machine(userId);
				await storage.machines.create(input);
				let expected = structuredClone(input);
				expect(await storage.machines.byToken(input.tokenHash)).toEqual(expected);
				expect(await storage.machines.get(input.id)).toEqual(expected);
				expect(await storage.machines.byToken(bytes(32))).toBeUndefined();
				let found = await storage.machines.get(input.id);
				found!.tokenHash[0] = found!.tokenHash[0]! ^ 0xff;
				found!.repositories[0]!.repository = "changed/elsewhere";
				expect(await storage.machines.get(input.id)).toEqual(expected);
			} finally {
				await storage.close();
			}
		});

		it("refuses a duplicate token or a missing owner", async () => {
			let storage = await openedStorage(factory);
			try {
				let userId = await owner(storage);
				let input = machine(userId);
				await storage.machines.create(input);
				let duplicate = await storage.machines.create(
					machine(userId, { tokenHash: input.tokenHash }),
				)
					.catch(err => err);
				expect(duplicate).toBeInstanceOf(StorageError);
				expect((duplicate as StorageError).failure).toBe("conflict");
				let orphan = await storage.machines.create(machine(id("nobody"))).catch(err => err);
				expect(orphan).toBeInstanceOf(StorageError);
				expect((orphan as StorageError).failure).toBe("missing");
			} finally {
				await storage.close();
			}
		});

		it("lists an owner's unrevoked machines, newest first", async () => {
			let storage = await openedStorage(factory);
			try {
				let userId = await owner(storage);
				let other = await owner(storage);
				let first = machine(userId);
				let second = machine(userId, { createdAt: new Date("2026-01-03T03:04:05.000Z") });
				let revoked = machine(userId);
				await storage.machines.create(first);
				await storage.machines.create(second);
				await storage.machines.create(revoked);
				await storage.machines.create(machine(other));
				expect(await storage.machines.revoke(revoked.id, userId, new Date())).toBe(true);
				expect((await storage.machines.list(userId)).map(value => value.id)).toEqual([
					second.id,
					first.id,
				]);
			} finally {
				await storage.close();
			}
		});

		it("records when a machine was last seen, and stops once it is revoked", async () => {
			let storage = await openedStorage(factory);
			try {
				let userId = await owner(storage);
				let input = machine(userId);
				await storage.machines.create(input);
				let seen = new Date("2026-01-05T03:04:05.000Z");
				await storage.machines.seen(input.id, seen);
				expect((await storage.machines.get(input.id))?.lastSeenAt).toEqual(seen);
				await storage.machines.revoke(input.id, userId, seen);
				await storage.machines.seen(input.id, new Date("2026-01-06T03:04:05.000Z"));
				expect((await storage.machines.get(input.id))?.lastSeenAt).toEqual(seen);
			} finally {
				await storage.close();
			}
		});

		it("rotates credentials only from the expected revision of a live machine", async () => {
			let storage = await openedStorage(factory);
			try {
				let userId = await owner(storage);
				let input = machine(userId);
				await storage.machines.create(input);
				let next = { ciphertext: bytes(48, 2), revision: 2 };
				expect(await storage.machines.rotate(input.id, 2, { ...next, revision: 3 })).toBe(false);
				expect(await storage.machines.rotate(input.id, 1, next)).toBe(true);
				expect(await storage.machines.rotate(input.id, 1, next)).toBe(false);
				expect((await storage.machines.get(input.id))?.credentials).toEqual(next);
				await storage.machines.revoke(input.id, userId, new Date());
				expect(
					await storage.machines.rotate(input.id, 2, { ciphertext: bytes(48, 3), revision: 3 }),
				).toBe(false);
			} finally {
				await storage.close();
			}
		});

		it("marks a machine for re-authorization and drops its dead credentials", async () => {
			let storage = await openedStorage(factory);
			try {
				let userId = await owner(storage);
				let input = machine(userId);
				await storage.machines.create(input);
				let now = new Date("2026-01-05T03:04:05.000Z");
				expect(await storage.machines.reauthorize(input.id, 1, now)).toBe(true);
				// A refresh that raced ahead already replaced revision 1.
				expect(await storage.machines.reauthorize(input.id, 1, now)).toBe(false);
				let found = await storage.machines.get(input.id);
				expect(found?.reauthorizeAt).toEqual(now);
				expect(found?.credentials).toBeUndefined();
				expect(found?.revokedAt).toBeUndefined();
				expect((await storage.machines.list(userId)).map(value => value.id)).toEqual([input.id]);
			} finally {
				await storage.close();
			}
		});

		it("revokes only the owner's machine, once, and forgets its credentials", async () => {
			let storage = await openedStorage(factory);
			try {
				let userId = await owner(storage);
				let input = machine(userId);
				await storage.machines.create(input);
				let now = new Date("2026-01-05T03:04:05.000Z");
				expect(await storage.machines.revoke(input.id, id("someone-else"), now)).toBe(false);
				expect(await storage.machines.revoke(input.id, userId, now)).toBe(true);
				expect(await storage.machines.revoke(input.id, userId, new Date())).toBe(false);
				let found = await storage.machines.byToken(input.tokenHash);
				expect(found?.revokedAt).toEqual(now);
				expect(found?.credentials).toBeUndefined();
				expect(await storage.machines.revoke(id("missing"), userId, now)).toBe(false);
			} finally {
				await storage.close();
			}
		});
	});
}
