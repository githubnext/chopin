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
		generation: 0,
		expiresAt: later(900),
		...overrides,
	});
	return {
		userId,
		channelId,
		machineId: input.id,
		machineOwner: input.userId,
		launchId,
		placeholder,
	};
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

		test("keeps a key's suffix, and records its last use for the credential used alone, never moving it back", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId } = await userAndChannel(storage);
				let key: AiCredentialRecord = {
					userId,
					provider: "anthropic",
					kind: "api-key",
					ciphertext: bytes(48),
					suffix: "6789",
					updatedAt: AT,
				};
				await storage.aiCredentials.put(key);
				expect(await storage.aiCredentials.get(userId, "anthropic")).toEqual(key);

				await storage.aiCredentials.used(key, later(60));
				await storage.aiCredentials.used(key, later(30));
				expect(await storage.aiCredentials.get(userId, "anthropic")).toEqual({
					...key,
					lastUsedAt: later(60),
				});

				let replaced = { ...key, ciphertext: bytes(48), suffix: "4321" };
				await storage.aiCredentials.put(replaced);
				await storage.aiCredentials.used(key, later(90));
				expect(await storage.aiCredentials.get(userId, "anthropic")).toEqual(replaced);
				await storage.aiCredentials.used(replaced, later(120));
				expect(await storage.aiCredentials.list(userId)).toEqual([
					{ ...replaced, lastUsedAt: later(120) },
				]);

				await storage.aiCredentials.delete(userId, "anthropic");
				await storage.aiCredentials.used(replaced, later(150));
				expect(await storage.aiCredentials.get(userId, "anthropic")).toBeUndefined();
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
				delete unbound.generation;
				expect(await storage.aiPlaceholders.put([stored, unbound])).toBe(true);
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
				delete elsewhere.generation;
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

		test("stores no placeholder for a launch prepared before its document was archived, restored or not", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, placeholder } = await launched(storage);
				let generation = await storage.aiPlaceholders.generation(channelId);
				expect(generation).toBe(0);
				let before = placeholder({ generation });
				expect(await storage.aiPlaceholders.put([before])).toBe(true);

				await storage.channels.archive({ id: channelId, now: AT });
				expect(await storage.aiPlaceholders.generation(channelId)).toBeUndefined();
				let whileArchived = placeholder({ generation });
				expect(await storage.aiPlaceholders.put([whileArchived])).toBe(false);

				await storage.channels.restore({ id: channelId, now: later(1) });
				let afterRestore = placeholder({ generation });
				let unbound = placeholder({ provider: "anthropic" });
				delete unbound.channelId;
				delete unbound.generation;
				expect(await storage.aiPlaceholders.put([unbound, afterRestore])).toBe(false);
				for (let stale of [before, whileArchived, afterRestore, unbound]) {
					expect(await storage.aiPlaceholders.find(stale.digest, AT)).toBeUndefined();
				}

				let reopened = await storage.aiPlaceholders.generation(channelId);
				expect(reopened).toBe(1);
				let fresh = placeholder({ generation: reopened });
				expect(await storage.aiPlaceholders.put([fresh])).toBe(true);
				expect(await storage.aiPlaceholders.find(fresh.digest, AT)).toEqual(fresh);
				expect(await storage.aiPlaceholders.generation(id("nowhere"))).toBeUndefined();
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

		test("counts each write that ends AI authority by the time its caller hears it committed", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, machineId, machineOwner, launchId, placeholder } = await launched(
					storage,
				);
				let other = await owner(storage);
				let counted = async (write: () => Promise<unknown>) => {
					let before = storage.aiPlaceholders.cutoffs();
					await write();
					return storage.aiPlaceholders.cutoffs() - before;
				};
				let key: AiCredentialRecord = {
					userId,
					provider: "openai",
					kind: "api-key",
					ciphertext: bytes(48),
					updatedAt: AT,
				};
				let stored = placeholder();

				expect(await counted(() => storage.aiPlaceholders.put([stored]))).toBe(0);
				expect(await counted(() => storage.aiPlaceholders.find(stored.digest, AT))).toBe(0);
				expect(await counted(() => storage.aiPlaceholders.deleteExpired(AT))).toBe(0);
				let version = storage.aiCredentials.version(userId);
				expect(await counted(() => storage.aiCredentials.put(key))).toBe(1);
				expect(await counted(() => storage.aiCredentials.used(key, later(1)))).toBe(0);
				expect(await counted(() => storage.aiCredentials.put({ ...key, ciphertext: bytes(48) })))
					.toBe(1);
				expect(await counted(() => storage.aiCredentials.delete(userId, "openai"))).toBe(1);
				expect(storage.aiCredentials.version(userId)).toBe(version + 3);
				let theirs = storage.aiCredentials.version(other);
				await storage.aiCredentials.put({ ...key, userId: other });
				expect(storage.aiCredentials.version(userId)).toBe(version + 3);
				expect(storage.aiCredentials.version(other)).toBe(theirs + 1);

				expect(await counted(() => storage.aiPlaceholders.deleteLaunch(launchId))).toBe(1);
				expect(await counted(() => storage.aiPlaceholders.deleteForMachine(machineId))).toBe(1);
				expect(await counted(() => storage.machines.revoke(machineId, machineOwner, AT))).toBe(1);
				expect(await counted(() => storage.channels.archive({ id: channelId, now: AT }))).toBe(1);
				expect(await counted(() => storage.channels.restore({ id: channelId, now: later(1) })))
					.toBe(0);
			} finally {
				await storage.close();
			}
		});
	});
}
