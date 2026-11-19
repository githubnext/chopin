import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";
import type { AiAttemptStart } from "./model";

const AT = new Date("2026-01-02T03:04:05.000Z");

function later(seconds: number): Date {
	return new Date(AT.getTime() + seconds * 1_000);
}

function started(userId: string, overrides: Partial<AiAttemptStart> = {}): AiAttemptStart {
	return {
		id: id("attempt"),
		launchId: id("launch"),
		userId,
		provider: "openai",
		model: "gpt-test",
		startedAt: AT,
		...overrides,
	};
}

async function failure(action: () => Promise<unknown>) {
	let error = await action().then(() => undefined, (err: unknown) => err);
	expect(error).toBeInstanceOf(StorageError);
	return (error as StorageError).failure;
}

export function aiUsageContract(name: string, factory: StorageFactory) {
	describe(`${name} AI usage`, () => {
		test("records a request before it is sent and completes it once", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let attempt = started(userId);
				await storage.aiUsage.begin(lease, attempt);
				await storage.aiUsage.begin(lease, { ...attempt, model: "another" });
				expect(await storage.aiUsage.get(attempt.id)).toEqual({
					...attempt,
					outcome: "pending",
					tokens: {},
				});

				let result = {
					outcome: "ok" as const,
					status: 200,
					tokens: { input: 1_200, output: 80, cacheRead: 300, cacheWrite: 40 },
					completedAt: later(2),
				};
				expect(await storage.aiUsage.complete(lease, attempt.id, result)).toBe(true);
				expect(
					await storage.aiUsage.complete(lease, attempt.id, {
						...result,
						tokens: { input: 9, output: 9 },
						completedAt: later(3),
					}),
				).toBe(false);
				expect(await storage.aiUsage.get(attempt.id)).toEqual({
					...attempt,
					outcome: "ok",
					status: 200,
					tokens: result.tokens,
					completedAt: later(2),
				});
				expect(await storage.aiUsage.complete(lease, id("missing"), result)).toBe(false);
			} finally {
				await storage.close();
			}
		});

		test("sums only one person's requests since a time, by model, refused sends left out", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let other = id("user");
				await storage.users.put({ id: other, login: "hubot", avatarUrl: "a", now: AT });
				let finish = async (
					attempt: AiAttemptStart,
					outcome: "ok" | "error" | "unsent",
					tokens: { input?: number; output?: number } = {},
					status?: number,
				) => {
					await storage.aiUsage.begin(lease, attempt);
					await storage.aiUsage.complete(lease, attempt.id, {
						outcome,
						...(status ? { status } : {}),
						...(outcome === "ok" ? {} : { error: outcome === "unsent" ? "launch-ended" : "x" }),
						tokens,
						completedAt: later(1),
					});
				};
				await finish(started(userId), "ok", { input: 10, output: 5 }, 200);
				await finish(started(userId), "error", {}, 429);
				await finish(started(userId), "unsent");
				await finish(started(userId, { provider: "anthropic", model: "claude-test" }), "ok", {
					output: 7,
				}, 200);
				await finish(started(userId, { model: undefined }), "ok", {}, 200);
				await finish(started(userId, { startedAt: new Date(AT.getTime() - 1) }), "ok", {
					input: 1_000,
				}, 200);
				await finish(started(other), "ok", { input: 99 }, 200);
				await storage.aiUsage.begin(
					lease,
					started(userId, { model: "claude-test", provider: "anthropic" }),
				);

				expect(await storage.aiUsage.summary(userId, AT)).toEqual([
					{
						provider: "anthropic",
						model: "claude-test",
						requests: 2,
						errors: 0,
						unknown: 0,
						tokens: { input: 0, output: 7, cacheRead: 0, cacheWrite: 0 },
					},
					{
						provider: "openai",
						model: "gpt-test",
						requests: 2,
						errors: 1,
						unknown: 0,
						tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
					},
					{
						provider: "openai",
						requests: 1,
						errors: 0,
						unknown: 0,
						tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				]);
				expect(await storage.aiUsage.summary(id("nobody"), AT)).toEqual([]);
			} finally {
				await storage.close();
			}
		});

		test("the next holder of the writer lease marks a request left pending unknown", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId } = await userAndChannel(storage);
				let writer = id("writer");
				let first = (await storage.leases.acquire(writer, "first", 60_000))!;
				let sent = started(userId);
				let ended = started(userId);
				await storage.aiUsage.begin(first, sent);
				await storage.aiUsage.begin(first, ended);
				await storage.aiUsage.complete(first, ended.id, {
					outcome: "ok",
					status: 200,
					tokens: { output: 3 },
					completedAt: later(1),
				});
				await storage.leases.release(first);
				let second = (await storage.leases.acquire(writer, "second", 60_000))!;
				let own = started(userId);
				await storage.aiUsage.begin(second, own);

				expect(
					await failure(() =>
						storage.aiUsage.complete(first, sent.id, {
							outcome: "ok",
							status: 200,
							tokens: { output: 5 },
							completedAt: later(2),
						})
					),
				).toBe("conflict");
				expect(await storage.aiUsage.retire(second, later(5))).toBe(1);
				expect(await storage.aiUsage.retire(second, later(6))).toBe(0);
				expect(await storage.aiUsage.get(sent.id)).toMatchObject({
					outcome: "unknown",
					tokens: {},
					completedAt: later(5),
				});
				expect((await storage.aiUsage.get(ended.id))?.outcome).toBe("ok");
				expect((await storage.aiUsage.get(own.id))?.outcome).toBe("pending");
				expect(
					await storage.aiUsage.complete(second, sent.id, {
						outcome: "ok",
						status: 200,
						tokens: { output: 5 },
						completedAt: later(7),
					}),
				).toBe(false);
				expect(await storage.aiUsage.summary(userId, AT)).toEqual([{
					provider: "openai",
					model: "gpt-test",
					requests: 3,
					errors: 0,
					unknown: 1,
					tokens: { input: 0, output: 3, cacheRead: 0, cacheWrite: 0 },
				}]);
			} finally {
				await storage.close();
			}
		});

		test("refuses every write under a writer lease that has been taken over", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId } = await userAndChannel(storage);
				let writer = id("writer");
				let first = (await storage.leases.acquire(writer, "first", 60_000))!;
				await storage.leases.release(first);
				await storage.leases.acquire(writer, "second", 60_000);
				let attempt = started(userId);
				expect(await failure(() => storage.aiUsage.begin(first, attempt))).toBe("conflict");
				expect(await storage.aiUsage.get(attempt.id)).toBeUndefined();
				expect(await failure(() => storage.aiUsage.retire(first, later(1)))).toBe("conflict");
				expect(await failure(() => storage.aiUsage.deleteBefore(first, later(1)))).toBe(
					"conflict",
				);
			} finally {
				await storage.close();
			}
		});

		test("removes ended requests started before a time and keeps pending ones", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let old = started(userId, { startedAt: new Date("2000-01-01T00:00:00.000Z") });
				let oldPending = started(userId, { startedAt: new Date("2000-01-01T00:00:00.000Z") });
				let recent = started(userId);
				for (let attempt of [old, oldPending, recent]) {
					await storage.aiUsage.begin(lease, attempt);
				}
				for (let attempt of [old, recent]) {
					await storage.aiUsage.complete(lease, attempt.id, {
						outcome: "ok",
						status: 200,
						tokens: {},
						completedAt: later(1),
					});
				}
				await storage.aiUsage.deleteBefore(lease, new Date("2001-01-01T00:00:00.000Z"));
				expect(await storage.aiUsage.get(old.id)).toBeUndefined();
				expect((await storage.aiUsage.get(oldPending.id))?.outcome).toBe("pending");
				expect((await storage.aiUsage.get(recent.id))?.outcome).toBe("ok");
			} finally {
				await storage.close();
			}
		});

		test("refuses a request for a person who does not exist", async () => {
			let storage = await openedStorage(factory);
			try {
				let { lease } = await userAndChannel(storage);
				expect(await failure(() => storage.aiUsage.begin(lease, started(id("ghost"))))).toBe(
					"missing",
				);
			} finally {
				await storage.close();
			}
		});
	});
}
