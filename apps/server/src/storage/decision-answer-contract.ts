import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";

const AT = new Date("2026-01-02T03:04:05.000Z");

function later(seconds: number): Date {
	return new Date(AT.getTime() + seconds * 1_000);
}

export function decisionAnswerContract(name: string, factory: StorageFactory) {
	describe(`${name} decision answers waiting for a Planner turn`, () => {
		test("keeps each decision's newest saved answer until the turn carrying it is delivered", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId } = await userAndChannel(storage);
				let answers = storage.decisionAnswers;
				await answers.save({ channelId, decisionId: "d1", generation: 1, savedAt: AT });
				await answers.save({ channelId, decisionId: "d2", generation: 1, savedAt: later(1) });
				// The same saved generation reported again changes nothing.
				await answers.save({ channelId, decisionId: "d1", generation: 1, savedAt: later(2) });
				expect(await answers.pending(channelId)).toEqual([
					{ decisionId: "d1", generation: 1, savedAt: AT },
					{ decisionId: "d2", generation: 1, savedAt: later(1) },
				]);

				let turn = id("turn");
				expect(
					await answers.claim(channelId, turn, [
						{ decisionId: "d1", generation: 1 },
						{ decisionId: "d2", generation: 1 },
					]),
				).toBe(2);
				expect(await answers.pending(channelId)).toEqual([
					{ decisionId: "d1", generation: 1, savedAt: AT, turnId: turn },
					{ decisionId: "d2", generation: 1, savedAt: later(1), turnId: turn },
				]);
				// Saving d2 again before the turn is marked makes its newer answer wait on its own.
				await answers.save({ channelId, decisionId: "d2", generation: 2, savedAt: later(3) });
				await answers.delivered(channelId, turn, later(4));

				expect(await answers.pending(channelId)).toEqual([
					{ decisionId: "d2", generation: 2, savedAt: later(3) },
				]);
				// A delivered answer reported again never waits a second time.
				await answers.save({ channelId, decisionId: "d1", generation: 1, savedAt: later(5) });
				await answers.save({ channelId, decisionId: "d2", generation: 1, savedAt: later(5) });
				expect(await answers.pending(channelId)).toEqual([
					{ decisionId: "d2", generation: 2, savedAt: later(3) },
				]);
				// A reopened and saved again decision waits once more.
				await answers.save({ channelId, decisionId: "d1", generation: 2, savedAt: later(6) });
				expect((await answers.pending(channelId)).map(answer => answer.decisionId))
					.toEqual(["d2", "d1"]);
			} finally {
				await storage.close();
			}
		});

		test("claims only answers still at the named generation, and releases a turn that did not start", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId } = await userAndChannel(storage);
				let answers = storage.decisionAnswers;
				await answers.save({ channelId, decisionId: "d1", generation: 2, savedAt: AT });
				let turn = id("turn");
				expect(await answers.claim(channelId, turn, [{ decisionId: "d1", generation: 1 }]))
					.toBe(0);
				expect(await answers.claim(channelId, turn, [{ decisionId: "d1", generation: 2 }]))
					.toBe(1);
				// Claimed by one turn, an answer is not claimed by another.
				expect(await answers.claim(channelId, id("other"), [{ decisionId: "d1", generation: 2 }]))
					.toBe(0);
				await answers.release(channelId, turn);
				expect(await answers.pending(channelId)).toEqual([
					{ decisionId: "d1", generation: 2, savedAt: AT },
				]);
			} finally {
				await storage.close();
			}
		});

		test("keeps each document's answers apart and forgets them with the document", async () => {
			let storage = await openedStorage(factory);
			try {
				let first = await userAndChannel(storage);
				let second = await userAndChannel(storage);
				let answers = storage.decisionAnswers;
				await answers.save({
					channelId: first.channelId,
					decisionId: "d1",
					generation: 1,
					savedAt: AT,
				});
				await answers.save({
					channelId: second.channelId,
					decisionId: "d1",
					generation: 3,
					savedAt: AT,
				});
				expect(await answers.pending(second.channelId)).toEqual([
					{ decisionId: "d1", generation: 3, savedAt: AT },
				]);

				await storage.channels.archive({ id: first.channelId, now: AT });
				expect(await storage.channels.delete(first.channelId)).toBe(true);
				expect(await answers.pending(first.channelId)).toEqual([]);
				expect(await answers.pending(second.channelId)).toHaveLength(1);

				let failure = await answers.save({
					channelId: id("missing-channel"),
					decisionId: "d1",
					generation: 1,
					savedAt: AT,
				}).catch(err => err);
				expect(failure).toBeInstanceOf(StorageError);
				expect((failure as StorageError).failure).toBe("missing");
			} finally {
				await storage.close();
			}
		});
	});
}
