import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";
import { machine, owner } from "./machine-contract";

import type { StorageFactory } from "./contract-support";
import type { AiCredentialRecord, AiPlaceholder } from "./model";
import type { StorageAdapter } from "./port";

const AT = new Date("2026-01-02T03:04:05.000Z");

function later(seconds: number): Date {
	return new Date(AT.getTime() + seconds * 1_000);
}

function bytes(length: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(length));
}

async function launched(storage: StorageAdapter) {
	let { userId, channelId } = await userAndChannel(storage);
	let input = machine(await owner(storage));
	await storage.machines.create(input);
	let launchId = id("launch");
	let launchDigest = bytes(32);
	let placeholder = (overrides: Partial<AiPlaceholder> = {}): AiPlaceholder => ({
		digest: bytes(32),
		launchId,
		launchDigest,
		userId,
		provider: "openai",
		machineId: input.id,
		channelId,
		expiresAt: later(900),
		...overrides,
	});
	return { userId, channelId, machineId: input.id, launchId, placeholder };
}

async function failure(action: () => Promise<unknown>) {
	let error = await action().then(() => undefined, (err: unknown) => err);
	expect(error).toBeInstanceOf(StorageError);
	return (error as StorageError).failure;
}

export function aiCredentialContract(name: string, factory: StorageFactory) {
	describe(`${name} AI credentials`, () => {
		test("keeps one credential per person and provider, replaced whole and listed in order", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId } = await userAndChannel(storage);
				let other = await owner(storage);
				let key: AiCredentialRecord = {
					userId,
					provider: "openai",
					kind: "api-key",
					ciphertext: bytes(48),
					updatedAt: AT,
				};
				let signIn: AiCredentialRecord = {
					userId,
					provider: "github-copilot",
					kind: "github-sign-in",
					updatedAt: AT,
				};
				await storage.aiCredentials.put(key);
				await storage.aiCredentials.put(signIn);
				await storage.aiCredentials.put({ ...key, userId: other });
				expect(await storage.aiCredentials.list(userId)).toEqual([signIn, key]);

				let replaced = { ...key, ciphertext: bytes(48), updatedAt: later(60) };
				await storage.aiCredentials.put(replaced);
				expect(await storage.aiCredentials.get(userId, "openai")).toEqual(replaced);
				expect(await storage.aiCredentials.get(other, "openai")).toEqual({ ...key, userId: other });

				expect(await storage.aiCredentials.delete(userId, "openai")).toBe(true);
				expect(await storage.aiCredentials.delete(userId, "openai")).toBe(false);
				expect(await storage.aiCredentials.get(userId, "openai")).toBeUndefined();
				expect(await storage.aiCredentials.list(userId)).toEqual([signIn]);
				expect(
					await failure(() => storage.aiCredentials.put({ ...key, userId: id("nobody") })),
				).toBe("missing");
			} finally {
				await storage.close();
			}
		});

		test("finds a placeholder by its digest until it expires, and refuses a repeated digest", async () => {
			let storage = await openedStorage(factory);
			try {
				let { placeholder } = await launched(storage);
				let stored = placeholder();
				let unbound = placeholder({ provider: "anthropic" });
				delete unbound.machineId;
				delete unbound.channelId;
				await storage.aiPlaceholders.put([stored, unbound]);
				expect(await storage.aiPlaceholders.find(stored.digest, AT)).toEqual(stored);
				expect(await storage.aiPlaceholders.find(unbound.digest, AT)).toEqual(unbound);
				expect(await storage.aiPlaceholders.find(stored.digest, later(900))).toBeUndefined();
				expect(await storage.aiPlaceholders.find(bytes(32), AT)).toBeUndefined();

				expect(
					await failure(() => storage.aiPlaceholders.put([placeholder({ digest: stored.digest })])),
				)
					.toBe("conflict");
				expect(
					await failure(() => storage.aiPlaceholders.put([placeholder({ machineId: id("m") })])),
				)
					.toBe("missing");
				let fresh = placeholder();
				expect(
					await failure(() =>
						storage.aiPlaceholders.put([fresh, placeholder({ channelId: id("nowhere") })])
					),
				).toBe("missing");
				expect(await storage.aiPlaceholders.find(fresh.digest, AT)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("ends a launch, a machine's launches, and expired placeholders", async () => {
			let storage = await openedStorage(factory);
			try {
				let { placeholder, machineId } = await launched(storage);
				let first = placeholder();
				let second = placeholder({ provider: "anthropic" });
				let elsewhere = placeholder({ launchId: id("launch") });
				delete elsewhere.machineId;
				let expired = placeholder({ launchId: id("launch"), expiresAt: later(10) });
				await storage.aiPlaceholders.put([first, second]);
				await storage.aiPlaceholders.put([elsewhere]);
				await storage.aiPlaceholders.put([expired]);

				expect(await storage.aiPlaceholders.deleteExpired(later(10))).toBeGreaterThanOrEqual(1);
				expect(await storage.aiPlaceholders.find(expired.digest, AT)).toBeUndefined();

				expect(await storage.aiPlaceholders.deleteLaunch(first.launchId)).toBe(2);
				expect(await storage.aiPlaceholders.find(second.digest, AT)).toBeUndefined();
				expect(await storage.aiPlaceholders.find(elsewhere.digest, AT)).toEqual(elsewhere);

				let onMachine = placeholder({ launchId: id("launch") });
				await storage.aiPlaceholders.put([onMachine]);
				expect(await storage.aiPlaceholders.deleteForMachine(machineId)).toBe(1);
				expect(await storage.aiPlaceholders.find(onMachine.digest, AT)).toBeUndefined();
				expect(await storage.aiPlaceholders.find(elsewhere.digest, AT)).toEqual(elsewhere);
			} finally {
				await storage.close();
			}
		});

		test("ends a document's placeholders for good when it is archived", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, placeholder } = await launched(storage);
				let onDocument = placeholder();
				let elsewhere = placeholder({ launchId: id("launch") });
				delete elsewhere.channelId;
				await storage.aiPlaceholders.put([onDocument]);
				await storage.aiPlaceholders.put([elsewhere]);
				await storage.channels.archive({ id: channelId, now: AT });
				await storage.channels.restore({ id: channelId, now: later(1) });
				expect(await storage.aiPlaceholders.find(onDocument.digest, AT)).toBeUndefined();
				expect(await storage.aiPlaceholders.find(elsewhere.digest, AT)).toEqual(elsewhere);
			} finally {
				await storage.close();
			}
		});

		test("goes with its document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, placeholder } = await launched(storage);
				let stored = placeholder();
				await storage.aiPlaceholders.put([stored]);
				await storage.channels.archive({ id: channelId, now: AT });
				expect(await storage.channels.delete(channelId)).toBe(true);
				expect(await storage.aiPlaceholders.find(stored.digest, AT)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});
	});
}
