import { describe, expect, test } from "bun:test";
import { completeAnalysis, enqueue, initialState, retryMessage } from "./domain";
import { message } from "./review.test-fixtures";

// Original callbacks/data: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/review.test.ts.

describe("reviewed conversation-plan analysis invariants", () => {
	test("failed queued analysis needs an explicit retry before completion", () => {
		let entry = message("m1", "A question?");
		let state = enqueue(initialState(), entry.id);
		state = completeAnalysis(state, entry.id, [], entry, {
			questionSetVersion: "v1",
			modelVersion: "model",
			status: "failed",
			passes: [],
			error: "temporary failure",
		});
		expect(() =>
			completeAnalysis(state, entry.id, [], entry, {
				questionSetVersion: "v1",
				modelVersion: "model",
				status: "unlinked",
				passes: [],
			})
		).toThrow(/retry|pending|queued/i);
		state = retryMessage(state, entry.id);
		state = completeAnalysis(state, entry.id, [], entry, {
			questionSetVersion: "v1",
			modelVersion: "model",
			status: "unlinked",
			passes: [],
		});
		expect(state.queue).toEqual([]);
	});

	test("keeps at least 26 message diagnostics while remaining bounded", () => {
		let state = initialState();
		for (let index = 0; index < 26; index++) {
			let entry = message(`analysis-${index}`, "No planning change");
			state = enqueue(state, entry.id);
			state = completeAnalysis(state, entry.id, [], entry, {
				questionSetVersion: "v1",
				modelVersion: "model",
				status: "unlinked",
				passes: [],
			});
		}
		expect(state.analysis).toHaveLength(26);
		expect(state.analysis[0].messageId).toBe("analysis-0");
		for (let index = 26; index < 66; index++) {
			let entry = message(`analysis-${index}`, "No planning change");
			state = enqueue(state, entry.id);
			state = completeAnalysis(state, entry.id, [], entry, {
				questionSetVersion: "v1",
				modelVersion: "model",
				status: "unlinked",
				passes: [],
			});
		}
		expect(state.analysis).toHaveLength(64);
		expect(state.analysis[0].messageId).toBe("analysis-2");
	});
});
