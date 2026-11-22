import { describe, expect, test } from "bun:test";

import { backgroundJob, contractId as id, openedStorage, userAndChannel } from "./contract-support";

import type { StorageFactory } from "./contract-support";

const AT = new Date("2026-01-02T03:04:05.000Z");

/** Settles either way: a write after a delete may be refused or do nothing, never more. */
function settled(write: () => Promise<unknown>): Promise<unknown> {
	return Promise.resolve().then(write).catch(() => undefined);
}

export function deletionContract(name: string, factory: StorageFactory) {
	describe(`${name} deleting a document`, () => {
		test("lets no write that arrives after the delete bring any of its rows back", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, sessionId, channelId, lease } = await userAndChannel(storage);
				let thread = {
					channelId,
					rootId: "root-1",
					root: { id: "root-1", author: { kind: "agent" as const }, text: "Hello", ts: 1 },
					forkedAt: 2,
					createdBy: "ana",
					entries: [],
					compactions: [],
					forkState: { bootstrapEntries: [] },
					updatedAt: AT,
				};
				expect((await storage.channels.delete({ id: channelId, lease })).map(item => item.id))
					.toEqual([channelId]);

				// What a Planner tool, a queued job, a recorder or a reconnecting client's buffered
				// edit would write, each arriving after the commit.
				await Promise.all([
					settled(() =>
						storage.collaboration.commit({
							channelId,
							lease,
							expectedRevision: 0,
							operationId: id("late-edit"),
							epoch: "late",
							update: new Uint8Array([1, 2, 3]),
							sidecar: { late: true },
							events: [],
							now: AT,
						})
					),
					settled(() =>
						storage.collaboration.checkpoint({
							channelId,
							lease,
							expectedRevision: 0,
							generation: id("late-generation"),
							revision: 0,
							throughSequence: 0,
							epoch: "late",
							source: "# Late\n",
							sourceHash: "sha256:late",
							document: new Uint8Array([4]),
							sidecar: { late: true },
							createdAt: AT,
						})
					),
					settled(() => storage.chatThreads.putThread(lease, thread)),
					settled(() =>
						storage.plannerModelChoices.put(lease, {
							channelId,
							model: "acme/large",
							userId,
							updatedAt: AT,
						})
					),
					settled(() =>
						storage.decisionAnswers.save({
							channelId,
							decisionId: "d1",
							generation: 1,
							savedAt: AT,
						})
					),
					settled(() =>
						storage.versions.record({
							channelId,
							authorId: userId,
							revision: 1,
							source: "# Late\n",
							sourceHash: "late",
							now: AT,
							idleMs: 60_000,
						})
					),
					settled(() => storage.jobs.enqueue(backgroundJob(channelId, lease, { now: AT }))),
					settled(() => storage.channels.claimAgentOwner(channelId, sessionId, AT)),
					settled(() => storage.navigation.setLastDocument(userId, channelId, AT)),
				]);

				expect(await storage.channels.get(channelId)).toBeUndefined();
				expect(await storage.collaboration.load(channelId, AT)).toBeUndefined();
				expect(await storage.channels.readAgent(channelId, AT)).toBeUndefined();
				expect(await storage.chatThreads.getThread(channelId, "root-1")).toBeUndefined();
				expect(await storage.plannerModelChoices.get(channelId)).toBeUndefined();
				expect(await storage.decisionAnswers.pending(channelId)).toEqual([]);
				expect(await storage.versions.list(channelId, 10)).toEqual([]);
				expect(await storage.jobs.list(channelId, 10)).toBeUndefined();
				expect((await storage.navigation.get(userId))?.lastDocumentId).toBeUndefined();
			} finally {
				await storage.close();
			}
		});
	});
}
