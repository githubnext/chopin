import { expect, it } from "bun:test";
import { storageContract } from "../contract";
import { backgroundJob, contractId as id, userAndChannel } from "../contract-support";
import { MemoryStorage } from "./adapter";

storageContract("memory", () => new MemoryStorage());

it("commits all research projections before a linked job can become terminal", async () => {
	let storage = new MemoryStorage();
	await storage.migrate();
	try {
		let { channelId, userId, lease } = await userAndChannel(storage);
		let now = new Date("2026-01-07T03:04:05.000Z");
		let references: { id: string; jobId: string }[] = [];
		for (let index = 0; index < 2; index++) {
			let workspaceId = id(`projection-workspace-${index}`);
			let started = await storage.research.start({
				id: workspaceId,
				channelId,
				title: "Inline research",
				question: `Question ${index}`,
				origin: "inline",
				createdBy: userId,
				turnId: id(`projection-turn-${index}`),
				messageId: id(`projection-message-${index}`),
				requestId: id(`projection-request-${index}`),
				idempotencyKey: id(`projection-start-${index}`),
				fingerprint: id(`projection-fingerprint-${index}`),
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
			references.push({ id: workspaceId, jobId: job.job.id });
		}

		let commit = storage.collaboration.commit({
			channelId,
			lease,
			expectedRevision: 0,
			operationId: id("multi-projection-commit"),
			epoch: "projection-epoch",
			update: new Uint8Array([1]),
			events: [],
			now,
			researchProjections: references.map(({ id }) => ({ id, action: "add" })),
		});
		let revisionBeforeTerminalization = Promise.resolve().then(async () => {
			let state = await storage.collaboration.load(channelId, now);
			await storage.jobs.cancel({
				channelId,
				jobId: references[0]!.jobId,
				now,
				lease,
			});
			return state?.channel.revision;
		});

		let [result, observedRevision] = await Promise.all([commit, revisionBeforeTerminalization]);
		expect(observedRevision).toBe(result.revision);
		expect(result.revision).toBe(1);
	} finally {
		await storage.close();
	}
});
