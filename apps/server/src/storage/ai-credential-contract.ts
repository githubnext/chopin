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
	let { userId, channelId, lease } = await userAndChannel(storage);
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
		launchDigest,
		lease,
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
				let { userId, lease } = await userAndChannel(storage);
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
				await storage.aiCredentials.put(lease, key);
				await storage.aiCredentials.put(lease, signIn);
				await storage.aiCredentials.put(lease, { ...key, userId: other });
				expect(await storage.aiCredentials.list(userId)).toEqual([signIn, key]);

				let replaced = { ...key, ciphertext: bytes(48), updatedAt: later(60) };
				await storage.aiCredentials.put(lease, replaced);
				expect(await storage.aiCredentials.get(userId, "openai")).toEqual(replaced);
				expect(await storage.aiCredentials.get(other, "openai")).toEqual({ ...key, userId: other });

				expect(await storage.aiCredentials.delete(lease, userId, "openai")).toBe(true);
				expect(await storage.aiCredentials.delete(lease, userId, "openai")).toBe(false);
				expect(await storage.aiCredentials.get(userId, "openai")).toBeUndefined();
				expect(await storage.aiCredentials.list(userId)).toEqual([signIn]);
				expect(
					await failure(() => storage.aiCredentials.put(lease, { ...key, userId: id("nobody") })),
				).toBe("missing");
			} finally {
				await storage.close();
			}
		});

		test("keeps a key's suffix, and records its last use for the credential used alone, never moving it back", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let key: AiCredentialRecord = {
					userId,
					provider: "anthropic",
					kind: "api-key",
					ciphertext: bytes(48),
					suffix: "6789",
					updatedAt: AT,
				};
				await storage.aiCredentials.put(lease, key);
				expect(await storage.aiCredentials.get(userId, "anthropic")).toEqual(key);

				await storage.aiCredentials.used(key, later(60));
				await storage.aiCredentials.used(key, later(30));
				expect(await storage.aiCredentials.get(userId, "anthropic")).toEqual({
					...key,
					lastUsedAt: later(60),
				});

				let replaced = { ...key, ciphertext: bytes(48), suffix: "4321" };
				await storage.aiCredentials.put(lease, replaced);
				await storage.aiCredentials.used(key, later(90));
				expect(await storage.aiCredentials.get(userId, "anthropic")).toEqual(replaced);
				await storage.aiCredentials.used(replaced, later(120));
				expect(await storage.aiCredentials.list(userId)).toEqual([
					{ ...replaced, lastUsedAt: later(120) },
				]);

				await storage.aiCredentials.delete(lease, userId, "anthropic");
				await storage.aiCredentials.used(replaced, later(150));
				expect(await storage.aiCredentials.get(userId, "anthropic")).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("records a key its provider refused for that key alone, until it is connected again", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let key: AiCredentialRecord = {
					userId,
					provider: "openai",
					kind: "api-key",
					ciphertext: bytes(48),
					suffix: "6789",
					updatedAt: AT,
				};
				await storage.aiCredentials.put(lease, key);
				let version = storage.aiCredentials.version(userId);
				expect(await storage.aiCredentials.rejected(key, later(60))).toBe(true);
				// Counted for its person, as a replacement is, so a launch reading meanwhile reads again.
				expect(storage.aiCredentials.version(userId)).toBe(version + 1);
				expect(await storage.aiCredentials.rejected(key, later(90))).toBe(false);
				expect(storage.aiCredentials.version(userId)).toBe(version + 1);
				expect(await storage.aiCredentials.get(userId, "openai")).toEqual({
					...key,
					rejectedAt: later(60),
				});

				let replaced = { ...key, ciphertext: bytes(48), suffix: "4321", updatedAt: later(120) };
				await storage.aiCredentials.put(lease, replaced);
				expect(await storage.aiCredentials.rejected(key, later(150))).toBe(false);
				expect(await storage.aiCredentials.list(userId)).toEqual([replaced]);
			} finally {
				await storage.close();
			}
		});

		test("saves a sign-in's refreshed tokens only over the tokens the refresh began from, as no cutoff", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let signIn: AiCredentialRecord = {
					userId,
					provider: "claude",
					kind: "subscription",
					ciphertext: bytes(48),
					updatedAt: AT,
				};
				await storage.aiCredentials.put(lease, signIn);
				let version = storage.aiCredentials.version(userId);
				let first = bytes(48);
				let second = bytes(48);
				expect(await storage.aiCredentials.refreshed(lease, signIn, first)).toBe(true);
				// A second refresh that began from the same tokens lost the race: the newer pair stays.
				expect(await storage.aiCredentials.refreshed(lease, signIn, second)).toBe(false);
				let stored = await storage.aiCredentials.get(userId, "claude");
				expect(stored).toEqual({ ...signIn, tokens: first });
				expect(storage.aiCredentials.version(userId)).toBe(version);

				expect(await storage.aiCredentials.refreshed(lease, stored!, second)).toBe(true);
				expect((await storage.aiCredentials.get(userId, "claude"))?.tokens).toEqual(second);

				let again = { ...signIn, ciphertext: bytes(48), updatedAt: later(60) };
				await storage.aiCredentials.put(lease, again);
				expect(await storage.aiCredentials.refreshed(lease, { ...stored!, tokens: second }, first))
					.toBe(false);
				expect(await storage.aiCredentials.list(userId)).toEqual([again]);
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

		test("finds a launch by its credential's digest, and lists each owned launch once, until they end or expire", async () => {
			let storage = await openedStorage(factory);
			try {
				let { placeholder, launchDigest, channelId, lease } = await launched(storage);
				let first = placeholder({ owner: "run:run-1" });
				let second = placeholder({ owner: "run:run-1", provider: "anthropic" });
				let session = placeholder({
					launchId: id("launch"),
					launchDigest: bytes(32),
					owner: "session:session-1",
				});
				delete session.channelId;
				delete session.generation;
				let ownerless = placeholder({ launchId: id("launch"), launchDigest: bytes(32) });
				await storage.aiPlaceholders.put([first, second]);
				await storage.aiPlaceholders.put([session]);
				await storage.aiPlaceholders.put([ownerless]);

				expect(await storage.aiPlaceholders.find(first.digest, AT)).toEqual(first);
				expect(await storage.aiPlaceholders.findLaunch(launchDigest, AT)).toMatchObject({
					launchId: first.launchId,
					owner: "run:run-1",
				});
				expect(await storage.aiPlaceholders.findLaunch(bytes(32), AT)).toBeUndefined();
				expect(await storage.aiPlaceholders.findLaunch(launchDigest, later(900))).toBeUndefined();
				let owned = await storage.aiPlaceholders.owned(AT);
				expect(owned.sort((left, right) => left.owner!.localeCompare(right.owner!))).toEqual([
					{ launchId: first.launchId, owner: "run:run-1", channelId },
					{ launchId: session.launchId, owner: "session:session-1" },
				]);
				expect(await storage.aiPlaceholders.owned(later(900))).toEqual([]);

				await storage.aiPlaceholders.deleteLaunch(lease, first.launchId);
				expect(await storage.aiPlaceholders.findLaunch(launchDigest, AT)).toBeUndefined();
				expect(await storage.aiPlaceholders.owned(AT)).toEqual([
					{ launchId: session.launchId, owner: "session:session-1" },
				]);
			} finally {
				await storage.close();
			}
		});

		test("ends a launch, a machine's launches, and expired placeholders", async () => {
			let storage = await openedStorage(factory);
			try {
				let { placeholder, machineId, lease } = await launched(storage);
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

				expect(await storage.aiPlaceholders.deleteLaunch(lease, first.launchId)).toBe(2);
				expect(await storage.aiPlaceholders.find(second.digest, AT)).toBeUndefined();
				expect(await storage.aiPlaceholders.find(elsewhere.digest, AT)).toEqual(elsewhere);

				let onMachine = placeholder({ launchId: id("launch") });
				await storage.aiPlaceholders.put([onMachine]);
				expect(await storage.aiPlaceholders.deleteForMachine(lease, machineId)).toBe(1);
				expect(await storage.aiPlaceholders.find(onMachine.digest, AT)).toBeUndefined();
				expect(await storage.aiPlaceholders.find(elsewhere.digest, AT)).toEqual(elsewhere);
			} finally {
				await storage.close();
			}
		});

		test("ends a launch by its credential's digest only for the machine it was handed to", async () => {
			let storage = await openedStorage(factory);
			try {
				let { placeholder, machineId, launchDigest, lease } = await launched(storage);
				let first = placeholder();
				let second = placeholder({ provider: "anthropic" });
				let unbound = placeholder({ launchId: id("launch") });
				delete unbound.machineId;
				let another = placeholder({ launchId: id("launch"), launchDigest: bytes(32) });
				await storage.aiPlaceholders.put([first, second]);
				await storage.aiPlaceholders.put([unbound]);
				await storage.aiPlaceholders.put([another]);
				let otherMachine = machine(await owner(storage));
				await storage.machines.create(otherMachine);

				expect(
					await storage.aiPlaceholders.deleteHeldLaunch(lease, launchDigest, otherMachine.id),
				).toBe(0);
				expect(await storage.aiPlaceholders.find(first.digest, AT)).toEqual(first);
				expect(await storage.aiPlaceholders.deleteHeldLaunch(lease, launchDigest, machineId)).toBe(
					2,
				);
				expect(await storage.aiPlaceholders.find(first.digest, AT)).toBeUndefined();
				expect(await storage.aiPlaceholders.find(second.digest, AT)).toBeUndefined();
				expect(await storage.aiPlaceholders.find(unbound.digest, AT)).toEqual(unbound);
				expect(await storage.aiPlaceholders.find(another.digest, AT)).toEqual(another);
				expect(await storage.aiPlaceholders.deleteHeldLaunch(lease, launchDigest, machineId)).toBe(
					0,
				);
			} finally {
				await storage.close();
			}
		});

		test("ends a document's placeholders for good when it is archived", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, placeholder, lease } = await launched(storage);
				let onDocument = placeholder();
				let elsewhere = placeholder({ launchId: id("launch") });
				delete elsewhere.channelId;
				delete elsewhere.generation;
				await storage.aiPlaceholders.put([onDocument]);
				await storage.aiPlaceholders.put([elsewhere]);
				await storage.channels.archive({ id: channelId, now: AT, lease });
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
				let { channelId, placeholder, lease } = await launched(storage);
				let generation = await storage.aiPlaceholders.generation(channelId);
				expect(generation).toBe(0);
				let before = placeholder({ generation });
				expect(await storage.aiPlaceholders.put([before])).toBe(true);

				await storage.channels.archive({ id: channelId, now: AT, lease });
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
				let { channelId, placeholder, lease } = await launched(storage);
				let stored = placeholder();
				await storage.aiPlaceholders.put([stored]);
				await storage.channels.archive({ id: channelId, now: AT, lease });
				expect(await storage.channels.delete(channelId)).toBe(true);
				expect(await storage.aiPlaceholders.find(stored.digest, AT)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("refuses each write that ends AI authority under a writer lease no longer held, and changes nothing", async () => {
			let storage = await openedStorage(factory);
			try {
				let {
					userId,
					channelId,
					machineId,
					machineOwner,
					launchId,
					launchDigest,
					lease,
					placeholder,
				} = await launched(storage);
				let key: AiCredentialRecord = {
					userId,
					provider: "openai",
					kind: "api-key",
					ciphertext: bytes(48),
					updatedAt: AT,
				};
				await storage.aiCredentials.put(lease, key);
				let stored = placeholder();
				await storage.aiPlaceholders.put([stored]);
				expect(await storage.leases.release(lease)).toBe(true);
				let successor = await storage.leases.acquire(lease.name, id("successor"), 60_000);
				expect(successor).toBeDefined();

				let writes = [
					() => storage.machines.revoke(lease, machineId, machineOwner, AT),
					() => storage.channels.archive({ id: channelId, now: AT, lease }),
					() => storage.aiCredentials.put(lease, { ...key, ciphertext: bytes(48) }),
					() => storage.aiCredentials.delete(lease, userId, "openai"),
					() => storage.aiPlaceholders.deleteLaunch(lease, launchId),
					() => storage.aiPlaceholders.deleteHeldLaunch(lease, launchDigest, machineId),
					() => storage.aiPlaceholders.deleteForMachine(lease, machineId),
				];
				for (let write of writes) expect(await failure(write)).toBe("conflict");
				expect((await storage.machines.get(machineId))!.revokedAt).toBeUndefined();
				expect((await storage.channels.get(channelId))!.archivedAt).toBeUndefined();
				expect(await storage.aiCredentials.get(userId, "openai")).toEqual(key);
				expect(await storage.aiPlaceholders.find(stored.digest, AT)).toEqual(stored);

				expect(await storage.machines.revoke(successor!, machineId, machineOwner, AT)).toBe(true);
				expect(await storage.aiPlaceholders.deleteForMachine(successor!, machineId)).toBe(1);
				expect(await storage.aiPlaceholders.find(stored.digest, AT)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("counts each write that ends AI authority by the time its caller hears it committed", async () => {
			let storage = await openedStorage(factory);
			try {
				let {
					userId,
					channelId,
					machineId,
					machineOwner,
					launchId,
					launchDigest,
					lease,
					placeholder,
				} = await launched(storage);
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
				expect(await counted(() => storage.aiCredentials.put(lease, key))).toBe(1);
				expect(await counted(() => storage.aiCredentials.used(key, later(1)))).toBe(0);
				expect(
					await counted(() => storage.aiCredentials.put(lease, { ...key, ciphertext: bytes(48) })),
				)
					.toBe(1);
				expect(await counted(() => storage.aiCredentials.delete(lease, userId, "openai"))).toBe(1);
				expect(storage.aiCredentials.version(userId)).toBe(version + 3);
				let theirs = storage.aiCredentials.version(other);
				await storage.aiCredentials.put(lease, { ...key, userId: other });
				expect(storage.aiCredentials.version(userId)).toBe(version + 3);
				expect(storage.aiCredentials.version(other)).toBe(theirs + 1);

				expect(await counted(() => storage.aiPlaceholders.deleteLaunch(lease, launchId))).toBe(1);
				expect(
					await counted(() =>
						storage.aiPlaceholders.deleteHeldLaunch(lease, launchDigest, machineId)
					),
				).toBe(1);
				expect(await counted(() => storage.aiPlaceholders.deleteForMachine(lease, machineId))).toBe(
					1,
				);
				expect(await counted(() => storage.machines.revoke(lease, machineId, machineOwner, AT)))
					.toBe(1);
				expect(await counted(() => storage.channels.archive({ id: channelId, now: AT, lease })))
					.toBe(1);
				expect(await counted(() => storage.channels.restore({ id: channelId, now: later(1) })))
					.toBe(0);
			} finally {
				await storage.close();
			}
		});
	});
}
