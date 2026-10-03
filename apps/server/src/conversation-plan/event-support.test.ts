import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import {
	activeScopedSupport,
	applyEvent,
	currentScopedProposal,
	targetsScopedProposal,
} from "./events";

type Event = ConversationPlan.Event;
function source(
	role: ConversationPlan.SourceRole,
	quote: string,
	handle = "maggie",
	messageId = "message-1",
): ConversationPlan.SourceRef {
	return {
		messageId,
		author: { kind: "member", handle },
		quote,
		start: 0,
		end: quote.length,
		role,
	};
}
function base(id: string, version = 0): ConversationPlan.EventBase {
	return {
		id,
		threadId: "thread-1",
		observedThreadVersion: version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1,
	};
}
function scoped() {
	let state: ConversationPlan.State = {
		schemaVersion: 1,
		revision: 0,
		events: [],
		threads: [],
		queue: [],
		analysis: [],
	};
	state = applyEvent(state, {
		...base("open"),
		type: "thread.opened",
		source: source("question", "Which?"),
		question: "Which?",
	});
	state = applyEvent(state, { ...base("link", 1), type: "card.linked", questionnaireId: "card-1" });
	let proposal: Extract<Event, { type: "scoped-choice.proposed" }> = {
		...base("proposal", 2),
		type: "scoped-choice.proposed",
		source: source("support", "I'd pick Bun for the spike."),
		cardId: "card-1",
		optionId: "option-1",
		label: "Bun",
		scope: "spike",
	};
	state = applyEvent(state, proposal);
	return { state, proposal };
}
function agreement(
	version: number,
	id = "agreement",
): Extract<Event, { type: "scoped-choice.agreed" }> {
	return {
		...base(id, version),
		type: "scoped-choice.agreed",
		source: source("support", "yep, Bun for the spike.", "alex", id),
		proposalId: "proposal",
		cardId: "card-1",
		optionId: "option-1",
		label: "Bun",
		scope: "spike",
	};
}

test("support helpers resolve the current proposal and latest member evidence in event order", () => {
	let { state, proposal } = scoped();
	let first = agreement(3);
	state = applyEvent(state, first);
	let latest = agreement(4, "latest-agreement");
	state = applyEvent(state, latest);
	expect(currentScopedProposal(state.threads[0]!, state.events)?.id).toBe(proposal.id);
	expect(activeScopedSupport(state.events, proposal).map(event => event.id)).toEqual([
		"proposal",
		"latest-agreement",
	]);
	let legacy = structuredClone(state.threads[0]!);
	delete legacy.pendingScopedChoice!.proposalId;
	expect(currentScopedProposal(legacy, state.events)?.id).toBe(proposal.id);
	expect(currentScopedProposal(legacy, [...state.events, { ...proposal, id: "ambiguous" }]))
		.toBeUndefined();
});

test("withdrawal targets retain legacy absence while explicit null does not retract scoped support", () => {
	let { state, proposal } = scoped();
	let withdrawal: Extract<Event, { type: "stance.changed" }> = {
		...base("withdraw", 3),
		type: "stance.changed",
		source: source("withdrawal", "I withdraw"),
		position: "neutral",
	};
	expect(targetsScopedProposal(withdrawal, proposal.id, proposal.optionId)).toBe(true);
	expect(
		targetsScopedProposal(
			{ ...withdrawal, scopedProposalId: null },
			proposal.id,
			proposal.optionId,
		),
	).toBe(false);
	expect(
		targetsScopedProposal(
			{ ...withdrawal, scopedProposalId: "other" },
			proposal.id,
			proposal.optionId,
		),
	).toBe(false);
	expect(
		activeScopedSupport([...state.events, { ...withdrawal, scopedProposalId: null }], proposal).map(
			event => event.id,
		),
	).toEqual(["proposal"]);
	state = applyEvent(state, withdrawal);
	expect(activeScopedSupport(state.events, proposal)).toEqual([]);
	expect(state.threads[0]!.pendingScopedChoice).toBeUndefined();
});

test("scoped saves bind exact ordered active sources and preserve the provisional thread", () => {
	let { state, proposal } = scoped();
	let agreed = agreement(3);
	state = applyEvent(state, agreed);
	let save: Extract<Event, { type: "scoped-choice.saved" }> = {
		...base("save", 4),
		origin: "human",
		actor: { kind: "member", handle: "maggie" },
		type: "scoped-choice.saved",
		proposalId: proposal.id,
		supportEventIds: [proposal.id, agreed.id],
		cardId: "card-1",
		optionId: "option-1",
		label: "Bun",
		scope: "spike",
		sources: [proposal.source, agreed.source],
		expectedGeneration: 0,
	};
	expect(() => applyEvent(state, { ...save, supportEventIds: [agreed.id, proposal.id] })).toThrow(
		"saved scoped choice does not match the current proposal",
	);
	let saved = applyEvent(state, save);
	expect(saved.threads[0]!.status).toBe("exploring");
	expect(saved.threads[0]!.decision).toBeUndefined();
	expect(saved.threads[0]!.pendingScopedChoice?.proposalId).toBe(proposal.id);
	expect(() => applyEvent(saved, { ...save, id: "save-again", observedThreadVersion: 5 })).toThrow(
		"saved scoped choice does not match the current proposal",
	);
});
