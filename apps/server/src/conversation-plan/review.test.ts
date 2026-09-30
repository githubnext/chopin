import { describe, expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyCorrection, applyInference, initialState, restoreState } from "./domain";
import {
	addOption,
	alice,
	bob,
	correct,
	decide,
	message,
	open,
	source,
} from "./review.test-fixtures";

// Original callbacks/data: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/review.test.ts.

describe("reviewed conversation-plan invariants", () => {
	test("a question edit attributes the correcting member, distinct from its source speaker", () => {
		let state = open(initialState());
		state = correct(state, "edit-question", "t1", {
			kind: "edit",
			field: "question",
			text: "Should the outline be optional?",
		});
		expect(state.threads[0].questionEditedBy).toBe("bob");
		expect(state.threads[0].questionSources[0].author).toEqual(alice);
		expect(restoreState(JSON.parse(JSON.stringify(state))).threads[0].questionEditedBy).toBe("bob");
	});

	test("reopened status needs a current decision and retains its history", () => {
		let state = open(initialState());
		expect(() =>
			correct(state, "reopen-too-early", "t1", {
				kind: "set-status",
				status: "reopened",
			})
		).toThrow(/decid/i);
		state = decide(state);
		state = correct(state, "reopen-now", "t1", { kind: "set-status", status: "reopened" });
		expect(state.threads[0].status).toBe("reopened");
		expect(state.threads[0].decision).toBeUndefined();
		expect(state.threads[0].decisionHistory).toHaveLength(1);
	});

	test("an option with a historical decision link cannot move after reopening", () => {
		let state = open(initialState());
		state = addOption(state, "t1", "o1");
		state = decide(state, "o1");
		state = correct(state, "reopen", "t1", { kind: "set-status", status: "reopened" });
		state = open(state, "t2");
		expect(() =>
			correct(state, "move-o1", "t1", {
				kind: "move",
				contributionId: "o1",
				targetThreadId: "t2",
				targetVersion: 1,
			})
		).toThrow(/referenced/i);
	});

	test("moving into a full destination rejects the correction", () => {
		let state = open(initialState());
		state = addOption(state, "t1", "o1");
		state = open(state, "t2");
		for (let index = 0; index < 64; index++) {
			state = addOption(state, "t2", `target-${index}`);
		}
		expect(() =>
			correct(state, "overflow", "t1", {
				kind: "move",
				contributionId: "o1",
				targetThreadId: "t2",
				targetVersion: state.threads[1].version,
			})
		).toThrow(/limit|full/i);
		expect(state.threads[1].contributions).toHaveLength(64);
	});

	test("unknown fields cannot carry unbounded data in events or debug snapshots", () => {
		let entry = message("extra", "A question?");
		let event: ConversationPlan.Event = {
			id: "extra-event",
			type: "thread.opened",
			threadId: "t1",
			observedThreadVersion: 0,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 1,
			source: source(entry, "question"),
			question: entry.text,
		};
		let forged = { ...event, unbounded: "x".repeat(100_000) } as ConversationPlan.Event;
		expect(() => applyInference(initialState(), forged, entry)).toThrow(/unknown|unexpected/i);
		let snapshot = initialState() as ConversationPlan.State & { unbounded?: string };
		snapshot.analysis.push({
			messageId: "m1",
			questionSetVersion: "v1",
			modelVersion: "model",
			status: "unlinked",
			passes: [],
			eventIds: [],
			unbounded: "x".repeat(100_000),
		} as ConversationPlan.AnalysisRecord);
		expect(() => restoreState(snapshot)).toThrow(/unknown|unexpected/i);
	});

	test("question edits reject an unrelated unbounded contribution ID", () => {
		let state = open(initialState());
		let failure: unknown;
		try {
			correct(state, "bad-question-edit", "t1", {
				kind: "edit",
				field: "question",
				text: "Revised question",
				contributionId: "x".repeat(1_000_000),
			} as unknown as ConversationPlan.CorrectionChange);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/invalid|unknown|contribution/i);
	});

	test("decision edits reject an unrelated contribution ID on ingress and restore", () => {
		let state = decide(open(initialState()));
		let failure: unknown;
		try {
			correct(state, "bad-decision-edit", "t1", {
				kind: "edit",
				field: "decision",
				text: "Revised decision",
				contributionId: "o1",
			} as unknown as ConversationPlan.CorrectionChange);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/invalid|unknown|contribution/i);
		let valid = correct(state, "good-decision-edit", "t1", {
			kind: "edit",
			field: "decision",
			text: "Revised decision",
		});
		let saved = JSON.parse(JSON.stringify(valid));
		saved.events.at(-1).change.contributionId = "o1";
		expect(() => restoreState(saved)).toThrow();
	});

	test("same human action ID is a noop only for an identical action", () => {
		let state = open(initialState());
		let action: ConversationPlan.CorrectionAction = {
			actionId: "edit-1",
			threadId: "t1",
			expectedVersion: 1,
			change: { kind: "edit", field: "question", text: "A revised question" },
		};
		let changed = applyCorrection(state, action, bob, 4);
		expect(applyCorrection(changed, action, bob, 5)).toBe(changed);
		let persisted = restoreState(JSON.parse(JSON.stringify(changed)));
		expect(applyCorrection(persisted, action, bob, 5)).toBe(persisted);
		expect(() =>
			applyCorrection(
				changed,
				{
					...action,
					change: { kind: "edit", field: "question", text: "A different question" },
				},
				bob,
				5,
			)
		).toThrow(/collision|different/i);
		expect(() => applyCorrection(changed, { ...action, expectedVersion: 2 }, bob, 5))
			.toThrow(/collision|different/i);
	});
});
