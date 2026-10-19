import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";
import type { RunStageRecord } from "./model";

function stages(count: number, from = 0): RunStageRecord[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `s${from + index}`,
		name: `stage ${from + index}`,
		status: "completed" as const,
		started: 1_000 + from + index,
		ended: 1_001 + from + index,
	}));
}

export function runStageContract(name: string, factory: StorageFactory) {
	describe(`${name} workflow run stages`, () => {
		test("keeps every one of 500 stages of a run, in order, and pages through them", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId } = await userAndChannel(storage);
				let runId = id("run");
				expect(await storage.runStages.put({ channelId, runId, stages: stages(300) })).toBe(300);
				expect(await storage.runStages.put({ channelId, runId, stages: stages(200, 300) }))
					.toBe(500);

				let first = await storage.runStages.list(channelId, runId, { offset: 0, limit: 200 });
				expect(first.total).toBe(500);
				expect(first.stages).toHaveLength(200);
				expect(first.stages[0]).toEqual(stages(1)[0]!);
				let last = await storage.runStages.list(channelId, runId, { offset: 400, limit: 200 });
				expect(last.stages.map(stage => stage.id)).toEqual(stages(100, 400).map(stage => stage.id));
				let all: RunStageRecord[] = [];
				for (let offset = 0; offset < 500; offset += 200) {
					all.push(
						...(await storage.runStages.list(channelId, runId, { offset, limit: 200 })).stages,
					);
				}
				expect(all).toEqual(stages(500));
				expect(await storage.runStages.list(channelId, id("other-run"), { offset: 0, limit: 10 }))
					.toEqual({ stages: [], total: 0 });
			} finally {
				await storage.close();
			}
		});

		test("updates a known stage in place, appends new ones, and replaces a run's set", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId } = await userAndChannel(storage);
				let runId = id("run");
				await storage.runStages.put({
					channelId,
					runId,
					stages: [
						{ id: "a", name: "plan", status: "running", started: 10 },
						{ id: "b", name: "review", kind: "tool", status: "pending", parentIds: ["a"] },
					],
				});
				let total = await storage.runStages.put({
					channelId,
					runId,
					stages: [
						{ id: "c", name: "ship", status: "pending", parentIds: ["b", "a"] },
						{ id: "a", name: "plan", status: "completed", started: 10, ended: 20 },
						{ id: "c", name: "ship", status: "running", parentIds: ["b"], started: 21 },
					],
				});
				expect(total).toBe(3);
				expect((await storage.runStages.list(channelId, runId, { offset: 0, limit: 10 })).stages)
					.toEqual([
						{ id: "a", name: "plan", status: "completed", started: 10, ended: 20 },
						{ id: "b", name: "review", kind: "tool", status: "pending", parentIds: ["a"] },
						{ id: "c", name: "ship", status: "running", parentIds: ["b"], started: 21 },
					]);

				expect(
					await storage.runStages.put({
						channelId,
						runId,
						replace: true,
						stages: [{ id: "z", name: "again", status: "running" }, {
							id: "a",
							name: "plan",
							status: "failed",
						}],
					}),
				).toBe(2);
				expect((await storage.runStages.list(channelId, runId, { offset: 0, limit: 10 })).stages)
					.toEqual([
						{ id: "z", name: "again", status: "running" },
						{ id: "a", name: "plan", status: "failed" },
					]);
				expect(await storage.runStages.put({ channelId, runId, replace: true, stages: [] }))
					.toBe(0);
			} finally {
				await storage.close();
			}
		});

		test("forgets the stages of runs a document no longer shows, and of a deleted document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId } = await userAndChannel(storage);
				let kept = id("kept");
				let dropped = id("dropped");
				await storage.runStages.put({ channelId, runId: kept, stages: stages(3) });
				await storage.runStages.put({ channelId, runId: dropped, stages: stages(4) });
				await storage.runStages.retain(channelId, [kept]);
				expect((await storage.runStages.list(channelId, kept, { offset: 0, limit: 10 })).total)
					.toBe(3);
				expect((await storage.runStages.list(channelId, dropped, { offset: 0, limit: 10 })).total)
					.toBe(0);

				let now = new Date("2026-01-02T03:04:05.000Z");
				await storage.channels.archive({ id: channelId, now });
				expect(await storage.channels.delete(channelId)).toBe(true);
				expect((await storage.runStages.list(channelId, kept, { offset: 0, limit: 10 })).total)
					.toBe(0);
			} finally {
				await storage.close();
			}
		});

		test("refuses stages for a missing document", async () => {
			let storage = await openedStorage(factory);
			try {
				let failure = await storage.runStages.put({
					channelId: id("missing-channel"),
					runId: id("run"),
					stages: stages(1),
				}).catch(err => err);
				expect(failure).toBeInstanceOf(StorageError);
				expect((failure as StorageError).failure).toBe("missing");
			} finally {
				await storage.close();
			}
		});
	});
}
