import { describe, expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, completeAnalysis, enqueue, initialState, restoreState } from "./domain";
import { alice, bob, opened } from "./domain.test-fixtures";

describe("conversation plan events", () => {
	test("message completion applies events and bounded debug with queue removal", () => {
		let queued = enqueue(initialState(), "m1");
		let finished = completeAnalysis(queued, "m1", [opened()], alice, {
			questionSetVersion: "v1",
			modelVersion: "jev-test",
			status: "applied",
			passes: [{ stage: "triage", answers: { question: { type: "noul", noul: 0.9 } } }],
			policyGate: "clear question",
			latencyMs: 12,
		});
		expect(finished.queue).toEqual([]);
		expect(finished.analysis[0].eventIds).toEqual(["m1:0:thread.opened:v1"]);
		expect(finished.threads).toHaveLength(1);
		let bad = { ...opened(), id: "bad", observedThreadVersion: 3 };
		expect(() =>
			completeAnalysis(queued, "m1", [bad], alice, {
				questionSetVersion: "v1",
				modelVersion: "jev-test",
				status: "applied",
				passes: [],
			})
		).toThrow();
		expect(queued.threads).toHaveLength(0);
	});

	test("completed debug data is detached from the caller's mutable response", () => {
		let debug: Omit<ConversationPlan.AnalysisRecord, "messageId" | "eventIds"> = {
			questionSetVersion: "v1",
			modelVersion: "jev-test",
			status: "unlinked",
			passes: [],
		};
		let finished = completeAnalysis(enqueue(initialState(), "m1"), "m1", [], alice, debug);
		debug.passes.push({ stage: "triage", answers: {} });
		expect(finished.analysis[0].passes).toEqual([]);
	});

	test("absent state is initial, malformed present snapshots fail closed", () => {
		expect(restoreState(undefined)).toEqual(initialState());
		expect(() =>
			restoreState({
				schemaVersion: 1,
				revision: 0,
				events: [],
				threads: [{}],
				queue: [],
				analysis: [],
			})
		).toThrow();
		let state = applyInference(initialState(), opened(), alice);
		expect(() => restoreState(state, [bob])).toThrow(/missing/i);
	});

	test("queue deduplicates message IDs across retry and restore", () => {
		let state = enqueue(initialState(), "m1");
		expect(enqueue(state, "m1")).toEqual(state);
		expect(restoreState(structuredClone(state)).queue).toEqual([{
			messageId: "m1",
			status: "pending",
			attempts: 0,
		}]);
	});

	test("restore rejects unbounded probability labels in debug data", () => {
		let state = initialState();
		state.analysis.push({
			messageId: "m1",
			questionSetVersion: "v1",
			modelVersion: "jev-test",
			status: "unlinked",
			passes: [{ stage: "triage", answers: { ["x".repeat(1000)]: { type: "noul", noul: 1 } } }],
			eventIds: [],
		});
		expect(() => restoreState(state)).toThrow();
	});
});
