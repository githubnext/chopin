import { expect, it } from "bun:test";
import {
	backgroundJob,
	contractId as id,
	openedStorage as opened,
	userAndChannel,
} from "./contract-support";
import type { StorageFactory as Factory } from "./contract-support";

export function researchInlineContract5(factory: Factory): void {
	it("pages only terminal Planner inline requests by workspace ID", async () => {
		let storage = await opened(factory);
		try {
			let { userId, channelId, lease } = await userAndChannel(storage);
			let expected: string[] = [];
			for (let index = 0; index < 4; index++) {
				let workspaceId = `terminal-${index}-${crypto.randomUUID()}`;
				let started = await storage.research.start({
					id: workspaceId,
					channelId,
					title: `Research ${index}`,
					question: `Question ${index}`,
					origin: "planner",
					originMessageId: id(`origin-${index}`),
					...(index < 3 ? { inlineReference: "pending" as const } : {}),
					createdBy: userId,
					turnId: id(`turn-${index}`),
					messageId: id(`message-${index}`),
					requestId: id(`request-${index}`),
					idempotencyKey: id(`start-${index}`),
					fingerprint: id(`fingerprint-${index}`),
					now: new Date("2026-01-07T03:04:05.000Z"),
					lease,
				});
				if (index < 3) {
					await storage.research.markReferencePlaced({ channelId, workspaceId, lease });
				}
				let job = await storage.jobs.enqueue(backgroundJob(channelId, lease, {
					type: "research-evidence",
					targetKey: `research-evidence:workspace:${workspaceId}:turn:${started.turn.id}:evidence`,
					availableAt: new Date("2026-01-07T03:04:05.000Z"),
					now: new Date("2026-01-07T03:04:05.000Z"),
				}));
				await storage.research.linkJob({
					channelId,
					workspaceId,
					turnId: started.turn.id,
					role: "evidence",
					jobId: job.job.id,
					now: new Date("2026-01-07T03:04:06.000Z"),
					lease,
				});
				let [claimed] = await storage.jobs.claim({
					channelId,
					claimOwner: `worker-${index}`,
					count: 1,
					ttlMs: 60_000,
					now: new Date("2026-01-07T03:04:07.000Z"),
					lease,
				});
				await storage.jobs.fail({
					channelId,
					jobId: claimed!.id,
					claimOwner: `worker-${index}`,
					claimGeneration: claimed!.claimGeneration,
					reason: "failed",
					now: new Date("2026-01-07T03:04:08.000Z"),
					lease,
				});
				if (index < 3) expected.push(workspaceId);
			}
			let recovered: string[] = [];
			let after: string | undefined;
			for (let index = 0; index < 3; index++) {
				let page = await storage.research.listTerminalRecovery(1, after, channelId);
				expect(page).toHaveLength(1);
				recovered.push(page[0]!.id);
				after = page[0]!.id;
			}
			expect(recovered).toEqual(expected);
			expect(await storage.research.listTerminalRecovery(1, after, channelId))
				.toEqual([]);
		} finally {
			await storage.close();
		}
	});
}
