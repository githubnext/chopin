import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";
import type { McpInvocation } from "./model";

const AT = new Date("2026-01-02T03:04:05.000Z");
const DAY_MS = 24 * 60 * 60_000;

function later(ms: number): Date {
	return new Date(AT.getTime() + ms);
}

function invocation(
	scope: { userId: string; channelId: string },
	overrides: Partial<Omit<McpInvocation, "result">> = {},
): Omit<McpInvocation, "result"> {
	return {
		...scope,
		key: "hand-off-1",
		fingerprint: "fingerprint-1",
		entryId: id("entry"),
		createdAt: AT,
		expiresAt: later(DAY_MS),
		...overrides,
	};
}

const RESULT = {
	document: { id: "document", title: "Release plan", url: "https://chopin.test/documents/a/b/c" },
};

async function refusal(action: Promise<unknown>): Promise<StorageError> {
	let error = await action.then(() => undefined, err => err);
	expect(error).toBeInstanceOf(StorageError);
	return error as StorageError;
}

export function mcpInvocationContract(name: string, factory: StorageFactory) {
	describe(`${name} invoke_planner idempotency keys`, () => {
		test("keeps the first claim of a key, and its result once completed", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let first = invocation({ userId, channelId });
				expect(await storage.mcpInvocations.claim(lease, first)).toEqual({
					record: first,
					claimed: true,
				});
				let rival = invocation({ userId, channelId }, { fingerprint: "other", entryId: id("e") });
				expect(await storage.mcpInvocations.claim(lease, rival)).toEqual({
					record: first,
					claimed: false,
				});
				expect(await storage.mcpInvocations.complete(lease, { ...rival }, RESULT)).toBe(false);
				expect(await storage.mcpInvocations.complete(lease, first, RESULT)).toBe(true);
				expect(await storage.mcpInvocations.complete(lease, first, RESULT)).toBe(false);
				expect(await storage.mcpInvocations.release(lease, first)).toBe(false);
				let completed = { ...first, result: RESULT };
				expect(await storage.mcpInvocations.get(first)).toEqual(completed);
				expect(await storage.mcpInvocations.claim(lease, rival)).toEqual({
					record: completed,
					claimed: false,
				});
			} finally {
				await storage.close();
			}
		});

		test("gives a key to exactly one of several concurrent claims", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let claims = Array.from({ length: 5 }, () => invocation({ userId, channelId }));
				let outcomes = await Promise.all(
					claims.map(claim => storage.mcpInvocations.claim(lease, claim)),
				);
				let winners = outcomes.filter(outcome => outcome.claimed);
				expect(winners).toHaveLength(1);
				for (let outcome of outcomes) expect(outcome.record).toEqual(winners[0]!.record);
			} finally {
				await storage.close();
			}
		});

		test("releases only a pending claim naming its entry, which frees the key", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let first = invocation({ userId, channelId });
				await storage.mcpInvocations.claim(lease, first);
				expect(await storage.mcpInvocations.release(lease, { ...first, entryId: id("e") }))
					.toBe(false);
				expect(await storage.mcpInvocations.release(lease, first)).toBe(true);
				expect(await storage.mcpInvocations.get(first)).toBeUndefined();
				let next = invocation({ userId, channelId }, { fingerprint: "corrected" });
				expect(await storage.mcpInvocations.claim(lease, next)).toEqual({
					record: next,
					claimed: true,
				});
			} finally {
				await storage.close();
			}
		});

		test("scopes a key to its caller and document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let other = await userAndChannel(storage);
				let scopes = [
					{ userId, channelId },
					{ userId: other.userId, channelId },
					{ userId, channelId: other.channelId },
				];
				for (let scope of scopes) {
					let claim = invocation(scope);
					expect(await storage.mcpInvocations.claim(lease, claim)).toEqual({
						record: claim,
						claimed: true,
					});
				}
				await storage.mcpInvocations.complete(
					lease,
					(await storage.mcpInvocations.get({ ...scopes[0]!, key: "hand-off-1" }))!,
					RESULT,
				);
				expect(await storage.mcpInvocations.get({ ...scopes[1]!, key: "hand-off-1" }))
					.not.toHaveProperty("result");
				expect(await storage.mcpInvocations.get({ ...scopes[0]!, key: "hand-off-2" }))
					.toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("gives an expired key to the next claim and sweeps expired records", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let expiring = invocation({ userId, channelId });
				let lasting = invocation({ userId, channelId }, {
					key: "lasting",
					expiresAt: later(2 * DAY_MS),
				});
				await storage.mcpInvocations.claim(lease, expiring);
				await storage.mcpInvocations.complete(lease, expiring, RESULT);
				await storage.mcpInvocations.claim(lease, lasting);
				let renewed = invocation({ userId, channelId }, {
					fingerprint: "after-expiry",
					createdAt: later(DAY_MS),
					expiresAt: later(2 * DAY_MS),
				});
				expect(await storage.mcpInvocations.claim(lease, renewed)).toEqual({
					record: renewed,
					claimed: true,
				});
				await storage.mcpInvocations.deleteExpired(later(DAY_MS));
				expect(await storage.mcpInvocations.get(renewed)).toEqual(renewed);
				expect(await storage.mcpInvocations.get(lasting)).toEqual(lasting);
				expect(await storage.mcpInvocations.deleteExpired(later(2 * DAY_MS)))
					.toBeGreaterThanOrEqual(2);
				expect(await storage.mcpInvocations.get(renewed)).toBeUndefined();
				expect(await storage.mcpInvocations.get(lasting)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("clears a document's records when the document is deleted", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let other = await userAndChannel(storage);
				let doomed = invocation({ userId, channelId });
				let kept = invocation({ userId, channelId: other.channelId });
				await storage.mcpInvocations.claim(lease, doomed);
				await storage.mcpInvocations.complete(lease, doomed, RESULT);
				await storage.mcpInvocations.claim(lease, kept);
				await storage.channels.archive({ id: channelId, now: AT, lease });
				expect(await storage.mcpInvocations.get(doomed)).toMatchObject({ result: RESULT });
				expect(await storage.channels.delete(channelId)).toBe(true);
				expect(await storage.mcpInvocations.get(doomed)).toBeUndefined();
				expect(await storage.mcpInvocations.get(kept)).toEqual(kept);
				expect((await refusal(storage.mcpInvocations.claim(lease, doomed))).failure)
					.toBe("missing");
			} finally {
				await storage.close();
			}
		});

		test("refuses a writer lease that has been taken over", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let claim = invocation({ userId, channelId });
				await storage.mcpInvocations.claim(lease, claim);
				await storage.leases.release(lease);
				await storage.leases.acquire(lease.name, "successor", 60_000);
				for (
					let write of [
						() =>
							storage.mcpInvocations.claim(
								lease,
								invocation({ userId, channelId }, { key: "new" }),
							),
						() => storage.mcpInvocations.complete(lease, claim, RESULT),
						() => storage.mcpInvocations.release(lease, claim),
					]
				) expect((await refusal(write())).failure).toBe("conflict");
				expect(await storage.mcpInvocations.get(claim)).toEqual(claim);
			} finally {
				await storage.close();
			}
		});
	});
}
