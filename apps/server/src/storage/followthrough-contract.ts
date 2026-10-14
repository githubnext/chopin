import { describe, expect, test } from "bun:test";
import { contractId, openedStorage, userAndChannel } from "./contract-support";
import { completedInitialResearch } from "./research-publication-contract";
import type { StorageFactory } from "./contract-support";

export function followthroughContract(name: string, factory: StorageFactory) {
	describe(`${name} result follow-through`, () => {
		test("releases only the exact unstarted claim and never reuses attempt identity", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId, lease } = await userAndChannel(storage);
				let ready = await completedInitialResearch(storage, channelId, userId, lease);
				await storage.research.publishInitialReport({
					channelId,
					...ready,
					title: "Evidence",
					now: new Date(),
					lease,
				});
				let [pending] = await storage.followthrough.pending(channelId, 1);
				let store = storage.followthrough;
				let id = pending!.id;
				expect(
					await store.releaseUnstarted(channelId, id, 0, "not-running", "document-locked", lease),
				).toBeUndefined();
				let running =
					(await store.claim(channelId, id, 0, { planRevision: 1, sourceHash: "hash" }, lease))!;
				expect(
					await store.releaseUnstarted(
						channelId,
						id,
						0,
						running.attemptToken!,
						"document-locked",
						lease,
					),
				).toBeUndefined();
				expect(
					await store.releaseUnstarted(
						channelId,
						id,
						running.revision,
						"wrong-token",
						"document-locked",
						lease,
					),
				).toBeUndefined();
				await expect(
					store.releaseUnstarted(
						channelId,
						id,
						running.revision,
						running.attemptToken!,
						"document-locked",
						{ ...lease, owner: "another-writer" },
					),
				).rejects.toMatchObject({ failure: "conflict" });
				expect(await store.get(channelId, id)).toEqual(running);
				let released = (await store.releaseUnstarted(
					channelId,
					id,
					running.revision,
					running.attemptToken!,
					"document-locked",
					lease,
				))!;
				expect(released).toMatchObject({
					status: "pending",
					revision: 2,
					attempts: 1,
					reason: "document-locked",
				});
				expect(released.context).toBeUndefined();
				expect(released.attemptToken).toBeUndefined();
				expect(
					await store.releaseUnstarted(
						channelId,
						id,
						released.revision,
						running.attemptToken!,
						"document-locked",
						lease,
					),
				).toBeUndefined();
				let next = (await store.claim(channelId, id, released.revision, {
					planRevision: 2,
					sourceHash: "fresh",
				}, lease))!;
				expect(next).toMatchObject({ status: "running", revision: 3, attempts: 2 });
				expect(next.attemptToken).not.toBe(running.attemptToken);
				expect(await store.finish(channelId, id, running.revision, "done", undefined, lease))
					.toBeUndefined();
				let done = (await store.finish(channelId, id, next.revision, "done", undefined, lease))!;
				expect(
					await store.releaseUnstarted(
						channelId,
						id,
						done.revision,
						next.attemptToken!,
						"document-locked",
						lease,
					),
				).toBeUndefined();
			} finally {
				await storage.close();
			}
		});
		test("claims once, compares revisions, deduplicates deferral, and requires explicit retry after interruption", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId, lease } = await userAndChannel(storage);
				let ready = await completedInitialResearch(storage, channelId, userId, lease);
				await storage.research.publishInitialReport({
					channelId,
					...ready,
					title: "Evidence",
					now: new Date(),
					lease,
				});
				let [receipt] = await storage.followthrough.pending(channelId, 1);
				expect(receipt).toBeDefined();
				let id = receipt!.id;
				expect(await storage.followthrough.get(contractId("foreign"), id)).toBeUndefined();
				let deferred =
					(await storage.followthrough.defer(channelId, id, 0, "owner-unavailable", lease))!;
				expect(deferred).toMatchObject({ revision: 1, status: "pending", attempts: 0 });
				expect(await storage.followthrough.defer(channelId, id, 1, "owner-unavailable", lease))
					.toEqual(deferred);
				expect(
					await storage.followthrough.claim(channelId, id, 0, {
						planRevision: 3,
						sourceHash: "hash",
					}, lease),
				).toBeUndefined();
				let claims = await Promise.all([1, 2].map(() =>
					storage.followthrough.claim(
						channelId,
						id,
						1,
						{ planRevision: 3, sourceHash: "hash" },
						lease,
					)
				));
				expect(claims.filter(Boolean)).toHaveLength(1);
				let claimed = claims.find(Boolean)!;
				expect(claimed).toMatchObject({
					status: "running",
					revision: 2,
					attempts: 1,
					context: { planRevision: 3, sourceHash: "hash" },
				});
				expect(claimed.attemptToken).toBeString();
				expect(await storage.followthrough.pending(channelId, 10)).toEqual([]);
				expect(await storage.followthrough.recoverInterrupted(lease)).toBe(1);
				expect(await storage.followthrough.recoverInterrupted(lease)).toBe(0);
				let failed = (await storage.followthrough.get(channelId, id))!;
				expect(failed).toMatchObject({ status: "failed", revision: 3, reason: "interrupted" });
				expect(
					await storage.followthrough.finish(
						channelId,
						id,
						claimed.revision,
						"done",
						undefined,
						lease,
					),
				).toBeUndefined();
				let retried = (await storage.followthrough.retry(channelId, id, failed.revision, lease))!;
				expect(retried).toMatchObject({ status: "pending", attempts: 1, revision: 4 });
				expect(retried.context).toBeUndefined();
				let running = (await storage.followthrough.claim(channelId, id, 4, {
					planRevision: 9,
					sourceHash: "fresh",
				}, lease))!;
				expect(running.attemptToken).not.toBe(claimed.attemptToken);
				let done =
					(await storage.followthrough.finish(channelId, id, 5, "done", undefined, lease))!;
				expect(done).toMatchObject({ status: "done", revision: 6, attempts: 2 });
				expect(await storage.followthrough.retry(channelId, id, 6, lease)).toBeUndefined();
				expect(await storage.followthrough.dismiss(channelId, id, 6, lease)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("rejects failed initialization atomically and fences receipt changes", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId, lease } = await userAndChannel(storage);
				let ready = await completedInitialResearch(storage, channelId, userId, lease);
				let input = { channelId, ...ready, title: "Evidence", now: new Date(), lease };
				await expect(
					storage.research.publishInitialReport({ ...input, initial: undefined as never }),
				).rejects.toMatchObject({ failure: "conflict" });
				expect(await storage.channels.children(channelId, 10)).toEqual([]);
				expect(await storage.followthrough.pending(channelId, 10)).toEqual([]);
				await storage.research.publishInitialReport(input);
				let [receipt] = await storage.followthrough.pending(channelId, 10);
				let expired = (await storage.leases.acquire(contractId("expired"), "old-writer", 1))!;
				await Bun.sleep(10);
				await expect(storage.followthrough.dismiss(channelId, receipt!.id, 0, expired))
					.rejects.toMatchObject({ failure: "conflict" });
				await expect(
					storage.followthrough.dismiss(channelId, receipt!.id, 0, { ...lease, owner: "foreign" }),
				).rejects.toMatchObject({ failure: "conflict" });
				await expect(
					storage.followthrough.claim(channelId, receipt!.id, 0, {
						planRevision: -1,
						sourceHash: "hash",
					}, lease),
				).rejects.toMatchObject({ failure: "conflict" });
				await expect(storage.followthrough.defer(channelId, receipt!.id, 0, "x".repeat(161), lease))
					.rejects.toMatchObject({ failure: "conflict" });
				await expect(storage.followthrough.pending(channelId, 0)).rejects.toMatchObject({
					failure: "conflict",
				});
				expect(await storage.followthrough.dismiss(channelId, receipt!.id, 0, lease)).toMatchObject(
					{ status: "skipped", reason: "dismissed", revision: 1 },
				);
				expect(await storage.followthrough.retry(channelId, receipt!.id, 1, lease)).toBeUndefined();
				await storage.leases.release(lease);
				await expect(storage.followthrough.recoverInterrupted(lease)).rejects.toMatchObject({
					failure: "conflict",
				});
			} finally {
				await storage.close();
			}
		});

		test("skips invalid evidence without claiming and never publishes cancelled research", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId, lease } = await userAndChannel(storage);
				let cancelled = await completedInitialResearch(storage, channelId, userId, lease, false);
				await storage.jobs.cancel({
					channelId,
					jobId: cancelled.answerJobId,
					now: new Date(),
					lease,
				});
				await expect(storage.research.publishInitialReport({
					channelId,
					...cancelled,
					title: "Cancelled",
					now: new Date(),
					lease,
				})).rejects.toMatchObject({ failure: "conflict" });
				expect(await storage.followthrough.forSource(channelId, "research", cancelled.workspaceId))
					.toEqual([]);
				let ready = await completedInitialResearch(storage, channelId, userId, lease);
				await storage.research.publishInitialReport({
					channelId,
					...ready,
					title: "Ready",
					now: new Date(),
					lease,
				});
				let [receipt] = await storage.followthrough.pending(channelId, 10);
				expect(await storage.followthrough.skip(channelId, receipt!.id, 0, "invalid-source", lease))
					.toMatchObject({ status: "skipped", reason: "invalid-source", attempts: 0, revision: 1 });
				expect(
					await storage.followthrough.claim(channelId, receipt!.id, 1, {
						planRevision: 0,
						sourceHash: "hash",
					}, lease),
				).toBeUndefined();
				expect(await storage.followthrough.skip(channelId, receipt!.id, 1, "invalid-source", lease))
					.toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("rolls child and source publication back when receipt validation fails", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId, lease } = await userAndChannel(storage);
				let ready = await completedInitialResearch(
					storage,
					channelId,
					userId,
					lease,
					true,
					"w".repeat(257),
				);
				await expect(storage.research.publishInitialReport({
					channelId,
					...ready,
					title: "Evidence",
					now: new Date(),
					lease,
				})).rejects.toThrow("invalid follow-through metadata");
				expect(await storage.channels.children(channelId, 10)).toEqual([]);
				expect(
					(await storage.research.get(channelId, ready.workspaceId))?.workspace.publishedChannelId,
				).toBeUndefined();
				expect(await storage.followthrough.pending(channelId, 10)).toEqual([]);
			} finally {
				await storage.close();
			}
		});

		test("refuses a claim after the parent or evidence child is archived", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId, lease } = await userAndChannel(storage);
				let ready = await completedInitialResearch(storage, channelId, userId, lease);
				let published = await storage.research.publishInitialReport({
					channelId,
					...ready,
					title: "Evidence",
					now: new Date(),
					lease,
				});
				let [receipt] = await storage.followthrough.pending(channelId, 10);
				let context = { planRevision: 1, sourceHash: "hash" };
				await storage.channels.archive({ id: published.channel.id, now: new Date() });
				expect(await storage.followthrough.claim(channelId, receipt!.id, 0, context, lease))
					.toBeUndefined();
				await storage.channels.restore({ id: published.channel.id, now: new Date() });
				await storage.channels.archive({ id: channelId, now: new Date() });
				expect(await storage.followthrough.claim(channelId, receipt!.id, 0, context, lease))
					.toBeUndefined();
				expect(await storage.followthrough.get(channelId, receipt!.id)).toMatchObject({
					status: "pending",
					revision: 0,
					attempts: 0,
				});
				await storage.channels.restore({ id: channelId, now: new Date() });
				expect(await storage.followthrough.claim(channelId, receipt!.id, 0, context, lease))
					.toMatchObject({ status: "running", revision: 1, attempts: 1 });
				await storage.followthrough.finish(channelId, receipt!.id, 1, "done", undefined, lease);
			} finally {
				await storage.close();
			}
		});
	});
}
