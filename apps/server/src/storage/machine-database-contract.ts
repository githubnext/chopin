import { describe, expect, test } from "bun:test";

import { openedStorage, testLease } from "./contract-support";
import { machine, owner } from "./machine-contract";
import { machineStoreName } from "../machine-store/names";

import type { StorageFactory } from "./contract-support";
import type { StoredMachineDatabase } from "./model";
import type { StorageAdapter } from "./port";

const AT = new Date("2026-01-02T03:04:05.000Z");

function later(days: number): Date {
	return new Date(AT.getTime() + days * 86_400_000);
}

async function paired(storage: StorageAdapter) {
	let userId = await owner(storage);
	let input = machine(userId);
	await storage.machines.create(input);
	let login = (overrides: Partial<StoredMachineDatabase> = {}): StoredMachineDatabase => ({
		machineId: input.id,
		role: machineStoreName(input.id),
		revision: 1,
		ciphertext: crypto.getRandomValues(new Uint8Array(64)),
		state: "pending",
		updatedAt: AT,
		...overrides,
	});
	return { userId, machineId: input.id, login };
}

export function machineDatabaseContract(name: string, factory: StorageFactory) {
	describe(`${name} machine database logins`, () => {
		test("keeps the first login a machine claims and hands back copies", async () => {
			let storage = await openedStorage(factory);
			try {
				let { machineId, login } = await paired(storage);
				let first = login();
				expect(await storage.machineDatabases.claim(first)).toEqual(first);
				let second = login({ revision: 2 });
				expect(await storage.machineDatabases.claim(second)).toEqual(first);
				let found = (await storage.machineDatabases.get(machineId))!;
				found.ciphertext[0] = found.ciphertext[0]! ^ 0xff;
				expect(await storage.machineDatabases.get(machineId)).toEqual(first);
				expect(await storage.machineDatabases.many([machineId, "missing"])).toEqual([first]);
				expect(await storage.machineDatabases.many([])).toEqual([]);
			} finally {
				await storage.close();
			}
		});

		test("refuses a login for a machine that was never paired", async () => {
			let storage = await openedStorage(factory);
			try {
				let { login } = await paired(storage);
				await expect(storage.machineDatabases.claim(login({ machineId: "missing" }))).rejects
					.toThrow();
			} finally {
				await storage.close();
			}
		});

		test("changes a login's state and password, and only an existing one", async () => {
			let storage = await openedStorage(factory);
			try {
				let { machineId, login } = await paired(storage);
				await storage.machineDatabases.claim(login());
				let failed = login({ state: "failed", failure: "the server refused", updatedAt: later(1) });
				expect(await storage.machineDatabases.put(failed)).toBe(true);
				expect(await storage.machineDatabases.get(machineId)).toEqual(failed);
				let rotating = login({
					state: "ready",
					candidate: { revision: 2, ciphertext: crypto.getRandomValues(new Uint8Array(64)) },
					updatedAt: later(2),
				});
				expect(await storage.machineDatabases.put(rotating)).toBe(true);
				expect(await storage.machineDatabases.get(machineId)).toEqual(rotating);
				let rotated = login({
					revision: 2,
					ciphertext: rotating.candidate!.ciphertext,
					state: "ready",
					updatedAt: later(3),
				});
				expect(await storage.machineDatabases.put(rotated)).toBe(true);
				expect(await storage.machineDatabases.get(machineId)).toEqual(rotated);
				let other = await paired(storage);
				expect(await storage.machineDatabases.put(other.login({ state: "ready" }))).toBe(false);
				expect(await storage.machineDatabases.get(other.machineId)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("lists revoked machines' logins to disable, then disabled ones past retention", async () => {
			let storage = await openedStorage(factory);
			try {
				let kept = await paired(storage);
				let revoked = await paired(storage);
				await storage.machineDatabases.claim(kept.login({ state: "ready" }));
				await storage.machineDatabases.claim(revoked.login({ state: "ready" }));
				expect(await storage.machineDatabases.settling()).toEqual([]);
				await storage.machines.revoke(
					await testLease(storage),
					revoked.machineId,
					revoked.userId,
					AT,
				);
				expect((await storage.machineDatabases.settling()).map(value => value.machineId))
					.toEqual([revoked.machineId]);
				let disabled = revoked.login({
					state: "disabled",
					disabledAt: later(1),
					updatedAt: later(1),
				});
				await storage.machineDatabases.put(disabled);
				expect(await storage.machineDatabases.settling()).toEqual([]);
				expect(await storage.machineDatabases.settling(later(0))).toEqual([]);
				expect(await storage.machineDatabases.settling(later(1))).toEqual([disabled]);
				await storage.machineDatabases.put(
					revoked.login({
						state: "dropped",
						disabledAt: later(1),
						droppedAt: later(9),
						updatedAt: later(9),
					}),
				);
				expect(await storage.machineDatabases.settling(later(30))).toEqual([]);
			} finally {
				await storage.close();
			}
		});
	});
}
