import { expect, test } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";
import { initialState, restoreState } from "./domain";
import { assertStateShape } from "./validation";

let message: Chat.Entry = {
	id: "research-message",
	author: { kind: "member", handle: "ana" },
	text: "Investigate alternatives to our current provider.",
	ts: 1,
};

function offered(): ConversationPlan.State {
	let state = initialState();
	let source: ConversationPlan.ResearchSource = {
		messageId: message.id,
		author: { kind: "member", handle: "ana" },
		quote: message.text,
		start: 0,
		end: message.text.length,
	};
	state.researchOffers = [{
		id: "offer-1",
		needId: "topic-1",
		contextId: "scope-1",
		source,
		brief: "Compare available providers.",
		status: "offered",
		workflow: {
			version: 1,
			revision: 0,
			generation: 0,
			mode: "automatic",
			placementMessageId: message.id,
			sources: [source],
			context: {
				messages: [{ id: message.id, author: source.author, text: message.text }],
				decisions: [],
			},
			published: true,
			preparation: "ready",
			editedBy: [],
			additions: [],
		},
	}];
	return state;
}

test("legacy migration schedules only unfinished messages and preserves historical results", () => {
	let legacy: ConversationPlan.State = {
		schemaVersion: 1,
		revision: 2,
		events: [],
		threads: [],
		queue: [{ messageId: message.id, status: "processing", attempts: 1 }],
		analysis: [{
			messageId: "completed",
			questionSetVersion: "conversation-plan-8",
			modelVersion: "jev-1.13.0",
			status: "unlinked",
			passes: [{ stage: "triage", answers: { research_need: { type: "noul", noul: 0.1 } } }],
			eventIds: [],
		}],
	};
	let restored = restoreState(legacy);
	expect(restored.schemaVersion).toBe(2);
	expect(restored.analysis).toEqual(legacy.analysis);
	expect(restored.research?.queue).toEqual([{
		messageId: message.id,
		status: "pending",
		attempts: 1,
	}]);
	expect(restoreState(restored)).toEqual(restored);
	expect(legacy.research).toBeUndefined();
});

test("general offers restore without an invented decision and retain exact source provenance", () => {
	let state = offered();
	expect(restoreState(state, [message])).toEqual(state);
	state.researchOffers![0]!.workflow!.sources[0]!.quote = "Invented evidence";
	expect(() => restoreState(state, [message])).toThrow();
});

test("accepted snapshots must match the sealed brief and revision", () => {
	let state = offered();
	let offer = state.researchOffers![0]!;
	offer.status = "accepted";
	offer.action = {
		id: "start-1",
		kind: "research",
		actor: { kind: "member", handle: "bo" },
		principalId: "2",
		at: 2,
	};
	expect(() => assertStateShape(state)).toThrow();
	offer.workflow!.accepted = { brief: offer.brief, revision: 0, executionKey: offer.id };
	expect(() => assertStateShape(state)).not.toThrow();
	offer.brief = "Changed after acceptance";
	expect(() => assertStateShape(state)).toThrow("research accepted snapshot differs");
});

test("research analysis is independently validated and requires an existing source on restore", () => {
	let state = offered();
	state.research!.analysis.push({
		messageId: "missing",
		questionSetVersion: "conversation-research-1",
		modelVersion: "test",
		status: "unlinked",
		answers: { external: { type: "noul", noul: 0.9 } },
		policyGate: "unclear subject",
		latencyMs: 10,
	});
	expect(() => assertStateShape(state)).not.toThrow();
	expect(() => restoreState(state, [message])).toThrow("research analysis source message missing");
	state.research!.analysis[0]!.answers.external = { type: "noul", noul: 2 };
	expect(() => assertStateShape(state)).toThrow("invalid analysis probability");
});
