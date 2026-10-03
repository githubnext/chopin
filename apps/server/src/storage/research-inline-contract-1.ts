import { expect, it } from "bun:test";
import {
	backgroundJob,
	contractId as id,
	openedStorage as opened,
	userAndChannel,
} from "./contract-support";
import type { StorageFactory as Factory } from "./contract-support";

export function researchInlineContract1(factory: Factory): void {
	for (let terminal of ["failed", "cancelled", "published"] as const) {
		it(`conditions Research projection commits on ${terminal} request state`, async () => {
			let storage = await opened(factory);
			try {
				let { channelId, userId, lease } = await userAndChannel(storage);
				let now = new Date("2026-01-07T03:04:05.000Z");
				let workspaceId = id("inline-research");
				let started = await storage.research.start({
					id: workspaceId,
					channelId,
					title: "Inline research",
					question: "What changed?",
					origin: "inline",
					createdBy: userId,
					turnId: id("initial-turn"),
					messageId: id("initial-message"),
					requestId: id("initial-request"),
					idempotencyKey: id("inline-start"),
					fingerprint: id("inline-fingerprint"),
					now,
					lease,
				});
				let job = await storage.jobs.enqueue(backgroundJob(channelId, lease, {
					type: "research-answer",
					targetKey: `research-answer:workspace:${workspaceId}:turn:${started.turn.id}:answer`,
					availableAt: now,
					now,
				}));
				await storage.research.linkJob({
					channelId,
					workspaceId,
					turnId: started.turn.id,
					role: "answer",
					jobId: job.job.id,
					now,
					lease,
				});
				let revision = 0;
				let commit = async (action: "add" | "remove") => {
					let result = await storage.collaboration.commit({
						channelId,
						lease,
						expectedRevision: revision,
						operationId: id(`research-${action}`),
						epoch: "research-epoch",
						update: new Uint8Array([revision + 1]),
						sidecar: { revision: revision + 1 },
						events: [],
						now,
						researchProjections: [{ id: workspaceId, action }],
					});
					revision = result.revision;
				};
				await commit("add");
				await expect(commit("remove")).rejects.toMatchObject({ failure: "conflict" });
				let [claimed] = await storage.jobs.claim({
					channelId,
					claimOwner: id("worker"),
					count: 1,
					ttlMs: 60_000,
					now,
					lease,
				});
				if (!claimed) throw new Error("research job was not claimable");
				if (terminal === "failed") {
					await storage.jobs.fail({
						channelId,
						jobId: job.job.id,
						claimOwner: claimed.claimOwner!,
						claimGeneration: claimed.claimGeneration,
						reason: "test failure",
						now,
						lease,
					});
				} else if (terminal === "cancelled") {
					await storage.jobs.cancel({ channelId, jobId: job.job.id, now, lease });
				} else {
					await storage.jobs.settle({
						channelId,
						jobId: job.job.id,
						claimOwner: claimed.claimOwner!,
						claimGeneration: claimed.claimGeneration,
						artifact: { source: "# Report\n" },
						now,
						lease,
					});
					await commit("add");
					await storage.research.publishInitialReport({
						channelId,
						workspaceId,
						answerJobId: job.job.id,
						title: "Report",
						initial: {
							generation: id("generation"),
							epoch: "child-epoch",
							source: "# Report\n",
							sourceHash: "sha256:report",
							document: new Uint8Array([1]),
							sidecar: { revision: 0 },
						},
						now,
						lease,
					});
				}
				await expect(commit("add")).rejects.toMatchObject({ failure: "conflict" });
				expect((await storage.collaboration.load(channelId, now))?.channel.revision)
					.toBe(revision);
				await commit("remove");
			} finally {
				await storage.close();
			}
		});
	}
}
