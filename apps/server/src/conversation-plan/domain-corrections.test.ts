import { describe, expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyCorrection, applyInference, initialState, replay, restoreState } from "./domain";
import { applyEvent } from "./events";
import { alice, bob, opened, option, source } from "./domain.test-fixtures";

describe("conversation plan events", () => {
	test("restores JSON-persisted optional fields after decide, reopen and status correction", () => {
		let state = applyInference(initialState(), opened(), alice);
		state = applyEvent(state, {
			id: "m7:0:decision.recorded:v1",
			type: "decision.recorded",
			threadId: "t1",
			observedThreadVersion: 1,
			origin: "human",
			actor: { kind: "member", handle: "alice" },
			at: 7,
			text: "Use an outline",
			explicit: true,
		});
		state = applyEvent(state, {
			id: "m8:0:decision.reopened:v1",
			type: "decision.reopened",
			threadId: "t1",
			observedThreadVersion: 2,
			origin: "human",
			actor: { kind: "member", handle: "bob" },
			at: 8,
			explicit: true,
		});
		state = applyCorrection(
			state,
			{
				actionId: "status-exploring",
				threadId: "t1",
				expectedVersion: 3,
				change: { kind: "set-status", status: "exploring" },
			},
			{ kind: "member", handle: "alice" },
			9,
		);
		let saved = JSON.parse(JSON.stringify(state));
		let restored = restoreState(saved, [alice]);
		expect(restored).toEqual(saved);
	});

	test("human wording survives later classifier work and a wrong target can move", () => {
		let state = applyInference(initialState(), opened(), alice);
		state = applyInference(state, option(state), bob);
		let secondMessage = { ...alice, id: "m5", text: "What about blank canvas?" };
		let second: ConversationPlan.Event = {
			...opened(),
			id: "m5:0:thread.opened:v1",
			threadId: "t2",
			at: 5,
			source: source(secondMessage, "question"),
			question: "What about blank canvas?",
		};
		state = applyInference(state, second, secondMessage);
		state = applyCorrection(
			state,
			{
				actionId: "edit-o1",
				threadId: "t1",
				expectedVersion: 2,
				change: {
					kind: "edit",
					field: "contribution",
					contributionId: "o1",
					text: "Optional starter outline",
				},
			},
			{ kind: "member", handle: "alice" },
			6,
		);
		expect(state.threads[0].contributions[0].authoring).toBe("human-edited");
		let stale = option(state);
		stale.id = "m2:retry";
		stale.observedThreadVersion = 2;
		expect(() => applyInference(state, stale, bob)).toThrow(/stale/i);
		state = applyCorrection(
			state,
			{
				actionId: "move-o1",
				threadId: "t1",
				expectedVersion: state.threads[0].version,
				change: { kind: "move", contributionId: "o1", targetThreadId: "t2", targetVersion: 1 },
			},
			{ kind: "member", handle: "alice" },
			7,
		);
		expect(state.threads[0].contributions).toHaveLength(0);
		expect(state.threads[1].contributions[0].text).toBe("Optional starter outline");
		expect(state.threads[1].contributions[0].sources[0].messageId).toBe("m2");
		expect(replay(state.events).threads).toEqual(state.threads);
	});

	test("legacy resolution candidates replay, while new confirmations are refused", () => {
		let state = applyInference(initialState(), opened(), alice);
		let candidateMessage = { ...bob, id: "m6", text: "Maybe we agreed on an outline?" };
		let candidate: ConversationPlan.Event = {
			id: "m6:0:candidate.proposed:v1",
			type: "candidate.proposed",
			threadId: "t1",
			observedThreadVersion: 1,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 6,
			source: source(candidateMessage, "resolution"),
			candidate: { id: "c1", kind: "resolution", text: "Use an outline" },
		};
		state = applyEvent(state, candidate);
		state = applyCorrection(
			state,
			{
				actionId: "reject-c1",
				threadId: "t1",
				expectedVersion: 2,
				change: { kind: "reject-candidate", candidateId: "c1" },
			},
			{ kind: "member", handle: "alice" },
			7,
		);
		expect(state.threads[0].candidates[0].status).toBe("rejected");
		expect(state.threads[0].status).toBe("exploring");
		let second: ConversationPlan.Event = {
			...candidate,
			id: "m6:1:candidate.proposed:v1",
			observedThreadVersion: state.threads[0].version,
			candidate: { id: "c2", kind: "resolution", text: "Use an outline" },
		};
		state = applyEvent(state, second);
		expect(() =>
			applyCorrection(
				state,
				{
					actionId: "confirm-c2",
					threadId: "t1",
					expectedVersion: state.threads[0].version,
					change: { kind: "confirm-candidate", candidateId: "c2" },
				},
				{ kind: "member", handle: "alice" },
				8,
			)
		)
			.toThrow("decisions are recorded on the card");
		state = applyEvent(state, {
			id: "historic-confirm-c2",
			type: "candidate.confirmed",
			threadId: "t1",
			observedThreadVersion: state.threads[0].version,
			origin: "human",
			actor: { kind: "member", handle: "alice" },
			at: 8,
			candidateId: "c2",
		});
		expect(state.threads[0].status).toBe("decided");
		expect(state.threads[0].decision?.actor).toEqual({ kind: "member", handle: "alice" });
		expect(state.threads[0].decision?.sources[0].messageId).toBe("m6");
		expect(replay(state.events).threads).toEqual(state.threads);
		expect(restoreState(JSON.parse(JSON.stringify(state))).threads).toEqual(state.threads);
	});

	test("stale corrections fail and stable action IDs make retries idempotent", () => {
		let state = applyInference(initialState(), opened(), alice);
		let action: ConversationPlan.CorrectionAction = {
			actionId: "edit-question",
			threadId: "t1",
			expectedVersion: 1,
			change: { kind: "edit", field: "question", text: "Should we offer an outline?" },
		};
		let changed = applyCorrection(state, action, { kind: "member", handle: "bob" }, 3);
		expect(changed.threads[0].question).toBe("Should we offer an outline?");
		expect(applyCorrection(changed, action, { kind: "member", handle: "bob" }, 4)).toEqual(changed);
		expect(() =>
			applyCorrection(changed, { ...action, actionId: "another-action" }, {
				kind: "member",
				handle: "bob",
			}, 4)
		).toThrow(/stale/i);
	});
});
