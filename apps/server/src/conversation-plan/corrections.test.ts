import { describe, expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyCorrection, initialState, replay, restoreState } from "./domain";
import { applyEvent } from "./events";
import { add, bob, correct, open, stance } from "./corrections.test-fixtures";

// Original callbacks/data: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/corrections.test.ts.

describe("conversation card target corrections", () => {
	test("retargets a sourced objection while keeping its speaker, quote and history", () => {
		let state = add(add(open(initialState()), "option", "a"), "option", "b");
		state = stance(state, "chat020-stance", "a");
		let original = structuredClone(state.threads[0].stances[0]);
		let version = state.threads[0].version;
		let changed = correct(state, "retarget-chat020", {
			kind: "retarget-stance",
			stanceId: original.id,
			optionId: "b",
		});
		let thread = changed.threads[0];
		expect(thread.version).toBe(version + 1);
		expect(changed.revision).toBe(state.revision + 1);
		expect(thread.status).toBe("exploring");
		expect(thread.stances).toEqual([{
			...original,
			id: "human:bob:retarget-chat020",
			optionId: "b",
			corrects: original.id,
			correctedBy: "bob",
		}]);
		expect(thread.stanceHistory).toEqual([original, thread.stances[0]]);
		expect(thread.stances[0].participant).toBe("alice");
		expect(thread.stances[0].sources).toEqual(original.sources);
		expect(changed.events.at(-1)).toMatchObject({
			type: "card.corrected",
			actor: bob,
			change: { kind: "retarget-stance", stanceId: original.id, optionId: "b" },
		});
		expect("source" in changed.events.at(-1)!).toBe(false);
		let saved = JSON.parse(JSON.stringify(changed));
		let restored = restoreState(saved);
		expect(restored.threads).toEqual(saved.threads);
		expect(replay(restored.events).threads).toEqual(restored.threads);
		let forged = structuredClone(saved);
		forged.threads[0].stances[0].correctedBy = "mallory";
		expect(() => restoreState(forged)).toThrow(/snapshot/i);
		let retry = {
			actionId: "retarget-chat020",
			threadId: "t1",
			expectedVersion: version,
			change: { kind: "retarget-stance", stanceId: original.id, optionId: "b" } as const,
		};
		expect(applyCorrection(restored, retry, bob, 11)).toBe(restored);
		expect(() =>
			applyCorrection(
				restored,
				{
					...retry,
					change: { ...retry.change, optionId: "a" },
				},
				bob,
				11,
			)
		).toThrow(/collision/i);
	});

	test("dismisses a mistaken stance without inventing a neutral vote or reopening", () => {
		let state = stance(add(open(initialState()), "option", "a"), "wrong-objection", "a");
		let original = structuredClone(state.threads[0].stances[0]);
		state = correct(state, "dismiss-wrong", { kind: "dismiss-stance", stanceId: original.id });
		expect(state.threads[0].stances).toEqual([]);
		expect(state.threads[0].stanceHistory).toEqual([original]);
		expect(state.threads[0].status).toBe("exploring");
		expect(restoreState(JSON.parse(JSON.stringify(state))).events.at(-1)).toMatchObject({
			type: "card.corrected",
			actor: bob,
		});
		state = applyEvent(state, {
			id: "decision",
			type: "decision.recorded",
			threadId: "t1",
			observedThreadVersion: state.threads[0].version,
			origin: "human",
			actor: bob,
			at: 12,
			text: "Use a",
			optionId: "a",
			explicit: true,
		});
		expect(state.threads[0].status).toBe("decided");
		expect(replay(state.events).threads).toEqual(state.threads);
	});

	test("correction of an objection leaves an existing decision in place", () => {
		let state = add(add(open(initialState()), "option", "a"), "option", "b");
		state = applyEvent(state, {
			id: "card-decision",
			type: "decision.recorded",
			threadId: "t1",
			observedThreadVersion: state.threads[0].version,
			origin: "human",
			actor: bob,
			at: 10,
			text: "Choose a",
			optionId: "a",
			explicit: true,
		});
		state = stance(state, "late-objection", "a");
		let decision = structuredClone(state.threads[0].decision);
		state = correct(state, "move-objection", {
			kind: "retarget-stance",
			stanceId: "late-objection",
			optionId: "b",
		});
		expect(state.threads[0].status).toBe("decided");
		expect(state.threads[0].decision).toEqual(decision);
	});

	test("rejects stale stance identities, absent options, same targets and target collisions", () => {
		let state = add(add(open(initialState()), "option", "a"), "option", "b");
		state = stance(state, "old", "a");
		state = stance(state, "current", "a");
		state = stance(state, "on-b", "b");
		let before = structuredClone(state);
		for (
			let change of [
				{ kind: "retarget-stance", stanceId: "old", optionId: "b" },
				{ kind: "dismiss-stance", stanceId: "old" },
				{ kind: "retarget-stance", stanceId: "current", optionId: "missing" },
				{ kind: "retarget-stance", stanceId: "current", optionId: "a" },
				{ kind: "retarget-stance", stanceId: "current", optionId: "b" },
			] as ConversationPlan.CorrectionChange[]
		) {
			expect(() =>
				correct(
					state,
					`reject-${change.kind}-${"optionId" in change ? change.optionId : "old"}`,
					change,
				)
			)
				.toThrow();
		}
		expect(() =>
			correct(
				state,
				"stale",
				{ kind: "dismiss-stance", stanceId: "current" },
				state.threads[0].version - 1,
			)
		).toThrow(/stale/i);
		expect(state).toEqual(before);
		expect(() =>
			correct(state, "unknown-field", {
				kind: "dismiss-stance",
				stanceId: "current",
				extra: "forged",
			} as unknown as ConversationPlan.CorrectionChange)
		).toThrow(/unknown/i);
	});
});
