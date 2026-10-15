import { describe, expect, it } from "bun:test";
import { openedStorage, userAndChannel } from "./contract-support";
import type { StorageFactory } from "./contract-support";
import type { AgendaRecord, AgendaRun } from "./agenda";

export function agendaContract(name: string, factory: StorageFactory) {
	describe(`${name} research agendas`, () => {
		it("commits launch intent atomically, fences revisions, and retains old request authority", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId, sessionId, lease } = await userAndChannel(storage);
				let record: AgendaRecord = {
					channelId,
					revision: 1,
					generation: 1,
					scope: "Public onboarding research",
					state: "active",
					questions: [],
					investigations: 1,
					reservedSessions: 1,
					assessments: 1,
					updatedAt: new Date().toISOString(),
				};
				let run: AgendaRun = {
					id: crypto.randomUUID(),
					channelId,
					generation: 1,
					questionId: "question-1",
					question: "What explains open decisions?",
					owner: { userId, sessionId, userHandle: "octocat", generation: 1, credentialRevision: 0 },
					createdAt: record.updatedAt,
					deadline: record.updatedAt,
				};
				await storage.agendas.save({ record, expectedRevision: 0, run, lease });
				expect(await storage.agendas.run(channelId, run.id)).toEqual(run);
				expect(await storage.agendas.get(channelId)).toEqual(record);
				expect(await storage.agendas.active()).toContain(channelId);
				let stale = { ...record, revision: 1, scope: "Stale scope" };
				let orphan = { ...run, id: crypto.randomUUID() };
				await expect(
					storage.agendas.save({ record: stale, expectedRevision: 0, run: orphan, lease }),
				).rejects.toThrow();
				expect(await storage.agendas.run(channelId, orphan.id)).toBeUndefined();
				let changed: AgendaRecord = { ...record, revision: 2, generation: 2, state: "paused" };
				await storage.agendas.save({ record: changed, expectedRevision: 1, lease });
				expect(await storage.agendas.active()).not.toContain(channelId);
				expect((await storage.agendas.run(channelId, run.id))?.generation).toBe(1);
				await storage.agendas.linkRun({
					channelId,
					requestId: run.id,
					workspaceId: "workspace-one",
					lease,
				});
				await storage.agendas.linkRun({
					channelId,
					requestId: run.id,
					workspaceId: "workspace-one",
					lease,
				});
				await expect(
					storage.agendas.linkRun({
						channelId,
						requestId: run.id,
						workspaceId: "workspace-two",
						lease,
					}),
				).rejects.toThrow();
				expect((await storage.agendas.run(channelId, run.id))?.workspaceId).toBe("workspace-one");
				expect(await storage.agendas.run("other-channel", run.id)).toBeUndefined();
				await expect(
					storage.agendas.save({
						record: { ...changed, revision: 3 },
						expectedRevision: 2,
						lease: { ...lease, fencing: lease.fencing + 1 },
					}),
				).rejects.toThrow();
			} finally {
				await storage.close();
			}
		});

		it("allows only one concurrent reservation at a revision", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let record: AgendaRecord = {
					channelId,
					revision: 1,
					generation: 1,
					scope: "Public onboarding research",
					state: "paused",
					questions: [],
					investigations: 0,
					reservedSessions: 0,
					assessments: 0,
					updatedAt: new Date().toISOString(),
				};
				let writes = await Promise.allSettled([
					storage.agendas.save({ record, expectedRevision: 0, lease }),
					storage.agendas.save({ record, expectedRevision: 0, lease }),
				]);
				expect(writes.filter(item => item.status === "fulfilled")).toHaveLength(1);
				expect(writes.filter(item => item.status === "rejected")).toHaveLength(1);
			} finally {
				await storage.close();
			}
		});
	});
}
