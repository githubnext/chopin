import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";
import { machine, owner } from "./machine-contract";

import type { StorageFactory } from "./contract-support";
import type { PlannerCredential } from "./model";
import type { StorageAdapter } from "./port";

const AT = new Date("2026-01-02T03:04:05.000Z");

function later(seconds: number): Date {
	return new Date(AT.getTime() + seconds * 1_000);
}

function digest(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

async function paired(storage: StorageAdapter) {
	let { channelId } = await userAndChannel(storage);
	let input = machine(await owner(storage));
	await storage.machines.create(input);
	let credential = (expiresAt: Date, overrides: Partial<PlannerCredential> = {}) => ({
		digest: digest(),
		machineId: input.id,
		channelId,
		expiresAt,
		...overrides,
	});
	return { channelId, machineId: input.id, credential };
}

export function plannerCredentialContract(name: string, factory: StorageFactory) {
	describe(`${name} machine Planner credentials`, () => {
		test("finds a credential by its digest until it expires, and hands back copies", async () => {
			let storage = await openedStorage(factory);
			try {
				let { credential } = await paired(storage);
				let stored = credential(later(900));
				await storage.plannerCredentials.put(stored);
				expect(await storage.plannerCredentials.find(stored.digest, AT)).toEqual(stored);
				expect(await storage.plannerCredentials.find(stored.digest, later(899))).toEqual(stored);
				// The expiry moment itself is already too late, as for every session.
				expect(await storage.plannerCredentials.find(stored.digest, later(900))).toBeUndefined();
				expect(await storage.plannerCredentials.find(digest(), AT)).toBeUndefined();
				let found = (await storage.plannerCredentials.find(stored.digest, AT))!;
				found.digest[0] = found.digest[0]! ^ 0xff;
				expect(await storage.plannerCredentials.find(stored.digest, AT)).toEqual(stored);
			} finally {
				await storage.close();
			}
		});

		test("refuses a digest already stored, an unknown machine and an unknown document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { credential } = await paired(storage);
				let stored = credential(later(900));
				await storage.plannerCredentials.put(stored);
				let failure = async (input: PlannerCredential) => {
					let error = await storage.plannerCredentials.put(input).catch(err => err);
					expect(error).toBeInstanceOf(StorageError);
					return (error as StorageError).failure;
				};
				expect(await failure(credential(later(900), { digest: stored.digest }))).toBe("conflict");
				expect(await failure(credential(later(900), { machineId: id("nobody") }))).toBe("missing");
				expect(await failure(credential(later(900), { channelId: id("nowhere") }))).toBe(
					"missing",
				);
			} finally {
				await storage.close();
			}
		});

		test("forgets one credential, one machine's credentials for a document, or all of its own", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, machineId, credential } = await paired(storage);
				let other = (await userAndChannel(storage)).channelId;
				let a = credential(later(900));
				let b = credential(later(900));
				let c = credential(later(900), { channelId: other });
				for (let stored of [a, b, c]) await storage.plannerCredentials.put(stored);

				expect(await storage.plannerCredentials.delete(a.digest)).toBe(true);
				expect(await storage.plannerCredentials.delete(a.digest)).toBe(false);
				expect(await storage.plannerCredentials.find(a.digest, AT)).toBeUndefined();

				expect(await storage.plannerCredentials.deleteForMachine(machineId, channelId)).toBe(1);
				expect(await storage.plannerCredentials.find(b.digest, AT)).toBeUndefined();
				expect(await storage.plannerCredentials.find(c.digest, AT)).toEqual(c);

				expect(await storage.plannerCredentials.deleteForMachine(machineId)).toBe(1);
				expect(await storage.plannerCredentials.find(c.digest, AT)).toBeUndefined();
				expect(await storage.plannerCredentials.deleteForMachine(machineId)).toBe(0);
			} finally {
				await storage.close();
			}
		});

		test("sweeps expired credentials and leaves the others", async () => {
			let storage = await openedStorage(factory);
			try {
				let { credential } = await paired(storage);
				let expired = credential(later(10));
				let live = credential(later(900));
				await storage.plannerCredentials.put(expired);
				await storage.plannerCredentials.put(live);
				expect(await storage.plannerCredentials.deleteExpired(later(10))).toBeGreaterThanOrEqual(1);
				expect(await storage.plannerCredentials.find(expired.digest, AT)).toBeUndefined();
				expect(await storage.plannerCredentials.find(live.digest, AT)).toEqual(live);
			} finally {
				await storage.close();
			}
		});

		test("goes with its document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, credential } = await paired(storage);
				let stored = credential(later(900));
				await storage.plannerCredentials.put(stored);
				await storage.channels.archive({ id: channelId, now: AT });
				expect(await storage.channels.delete(channelId)).toBe(true);
				expect(await storage.plannerCredentials.find(stored.digest, AT)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});
	});
}
