import { describe, expect, test } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState, replay, restoreState } from "./domain";
import { applyEvent } from "./events";
import { alice, bob, opened, option, source } from "./domain.test-fixtures";

describe("conversation plan events", () => {
	test("relabeling preserves quoted evidence and replays with the new display label", () => {
		let state = applyInference(initialState(), opened(), alice);
		state = applyInference(state, option(state), bob);
		state = applyEvent(state, {
			id: "linked",
			type: "card.linked",
			threadId: "t1",
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 3,
			questionnaireId: "card-1",
		});
		let before = structuredClone(state.threads[0]!.contributions[0]!);
		let event: ConversationPlan.Event = {
			id: "relabel-1",
			type: "option.relabeled",
			threadId: "t1",
			observedThreadVersion: state.threads[0]!.version,
			origin: "planner",
			actor: { kind: "agent" },
			at: 4,
			optionId: "o1",
			label: "Outline when useful",
			observedCardRevision: 0,
		};
		let changed = applyEvent(state, event);
		expect(changed.threads[0]!.contributions[0]).toMatchObject({
			...before,
			displayLabel: "Outline when useful",
		});
		expect(state.threads[0]!.contributions[0]).toEqual(before);
		expect(restoreState(changed, [alice, bob])).toEqual(changed);
		expect(replay(changed.events).threads).toEqual(changed.threads);
		expect(applyEvent(changed, event)).toBe(changed);
		expect(() => applyEvent(state, { ...event, label: "A or B" })).toThrow();
	});
	test("a Planner-scribed question opens without a fabricated chat source and replays", () => {
		let event: ConversationPlan.Event = {
			id: "planner-question",
			type: "thread.opened",
			threadId: "planner-thread",
			observedThreadVersion: 0,
			origin: "planner",
			actor: { kind: "agent" },
			at: 1,
			question: "Which approach should we take?",
		};
		let state = applyEvent(initialState(), event);
		expect(state.threads[0]).toMatchObject({
			questionSources: [],
			questionAuthoring: "scribe",
		});
		expect(restoreState(state, [])).toEqual(state);
		expect(replay(state.events).threads).toEqual(state.threads);
		expect(() =>
			applyEvent(initialState(), {
				...event,
				origin: "classifier",
				actor: { kind: "classifier" },
			})
		).toThrow("opening requires a question source");
	});

	test("accepted events replay to the same threads and revision", () => {
		let state = applyInference(initialState(), opened(), alice);
		state = applyInference(state, option(state), bob);
		let restored = restoreState(structuredClone(state));
		let rebuilt = replay(state.events);
		expect(restored).toEqual(state);
		expect(rebuilt.threads).toEqual(state.threads);
		expect(rebuilt.revision).toBe(state.revision);
	});

	test("rejects forged quote offsets and source authors", () => {
		let forged = opened();
		forged.source!.quote = "a different question";
		expect(() => applyInference(initialState(), forged, alice)).toThrow();
		forged = opened();
		forged.source!.author = { kind: "member", handle: "mallory" };
		expect(() => applyInference(initialState(), forged, alice)).toThrow();
	});

	test("deduplicates accepted IDs before checking a stale version", () => {
		let first = opened();
		let state = applyInference(initialState(), first, alice);
		expect(applyInference(state, first, alice)).toEqual(state);
		let stale = option(state);
		stale.observedThreadVersion = 0;
		expect(() => applyInference(state, stale, bob)).toThrow(/stale/i);
	});

	test("accepted event data cannot be changed by mutating the candidate later", () => {
		let candidate = opened();
		let state = applyInference(initialState(), candidate, alice);
		candidate.source!.quote = "forged later";
		let accepted = state.events[0];
		expect("source" in accepted && accepted.source?.quote).toBe("Should we start with an outline?");
		expect(state.threads[0].questionSources[0].quote).toBe("Should we start with an outline?");
	});

	test("shows the latest participant stance and retains the reversal", () => {
		let state = applyInference(initialState(), opened(), alice);
		state = applyInference(state, option(state), bob);
		let first: ConversationPlan.Event = {
			id: "m3:0:stance.changed:v1",
			type: "stance.changed",
			threadId: "t1",
			observedThreadVersion: state.threads[0].version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 3,
			source: source({ ...alice, id: "m3", text: "I support this" }, "support"),
			optionId: "o1",
			position: "support",
		};
		let supportMessage = { ...alice, id: "m3", text: "I support this" };
		state = applyInference(state, first, supportMessage);
		let reversalMessage = { ...alice, id: "m4", text: "Actually I oppose this" };
		let reversal: ConversationPlan.Event = {
			...first,
			id: "m4:0:stance.changed:v1",
			observedThreadVersion: state.threads[0].version,
			at: 4,
			source: source(reversalMessage, "objection"),
			position: "oppose",
		};
		state = applyInference(state, reversal, reversalMessage);
		expect(state.threads[0].stances).toMatchObject([
			{ participant: "alice", optionId: "o1", position: "oppose" },
		]);
		expect(state.threads[0].stanceHistory.map((stance) => stance.position)).toEqual([
			"support",
			"oppose",
		]);
	});

	test("preserves a decision after an explicit human reopening", () => {
		let state = applyInference(initialState(), opened(), alice);
		let decision: ConversationPlan.Event = {
			id: "m3:0:decision.recorded:v1",
			type: "decision.recorded",
			threadId: "t1",
			observedThreadVersion: 1,
			origin: "human",
			actor: { kind: "member", handle: "alice" },
			at: 3,
			text: "Use an outline",
			explicit: true,
		};
		state = applyEvent(state, decision);
		expect(state.threads[0].status).toBe("decided");
		let reopen: ConversationPlan.Event = {
			id: "m4:0:decision.reopened:v1",
			type: "decision.reopened",
			threadId: "t1",
			observedThreadVersion: state.threads[0].version,
			origin: "human",
			actor: { kind: "member", handle: "bob" },
			at: 4,
			explicit: true,
		};
		state = applyEvent(state, reopen);
		expect(state.threads[0].status).toBe("reopened");
		expect(state.threads[0].decision).toBeUndefined();
		expect(state.threads[0].decisionHistory).toHaveLength(1);
		expect(replay(state.events).threads).toEqual(state.threads);
	});

	test("an agent cannot decide or cast a participant stance", () => {
		let state = applyInference(initialState(), opened(), alice);
		let agent: Chat.Entry = {
			id: "agent1",
			author: { kind: "agent" },
			text: "We decided to use an outline",
			ts: 4,
		};
		let decision: ConversationPlan.Event = {
			id: "agent1:0:decision.recorded:v1",
			type: "decision.recorded",
			threadId: "t1",
			observedThreadVersion: 1,
			origin: "planner",
			actor: { kind: "agent" },
			at: 4,
			source: source(agent, "resolution"),
			text: "Use an outline",
			explicit: true,
		};
		expect(() => applyInference(state, decision, agent)).toThrow(
			"decisions are recorded on the card",
		);
		let stance: ConversationPlan.Event = {
			id: "agent1:0:stance.changed:v1",
			type: "stance.changed",
			threadId: "t1",
			observedThreadVersion: 1,
			origin: "planner",
			actor: { kind: "agent" },
			at: 4,
			source: source(agent, "support"),
			position: "support",
		};
		expect(() => applyInference(state, stance, agent)).toThrow(/human|member/i);
	});
});
