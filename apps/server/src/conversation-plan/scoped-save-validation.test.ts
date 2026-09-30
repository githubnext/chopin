import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { initialState, restoreState } from "./domain";
import { applyEvent } from "./events";

type Event = ConversationPlan.Event;
type Saved = Extract<Event, { type: "scoped-choice.saved" }>;

function source(handle: string, messageId: string, quote: string): ConversationPlan.SourceRef {
	return {
		messageId,
		author: { kind: "member", handle },
		quote,
		start: 0,
		end: quote.length,
		role: "support",
	};
}

function fixture() {
	let cardId = "01K0N4W3B7P27CBAEC7A8C8WEA";
	let optionId = "01K0N4W3B7P27CBAEC7A8C8WEB";
	let state = applyEvent(initialState(), {
		id: "open",
		type: "thread.opened",
		threadId: "thread-a",
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1,
		source: { ...source("Mei", "question", "Which editor?"), role: "question" },
		question: "Which editor?",
	});
	state = applyEvent(state, {
		id: "link",
		type: "card.linked",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 2,
		questionnaireId: cardId,
	});
	let proposal: Extract<Event, { type: "scoped-choice.proposed" }> = {
		id: "proposal",
		type: "scoped-choice.proposed",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 3,
		source: source("Mei", "mei", "I'd pick Lexical for the spike;"),
		cardId,
		optionId,
		label: "Lexical",
		scope: "spike",
	};
	state = applyEvent(state, proposal);
	let agreements: Array<Extract<Event, { type: "scoped-choice.agreed" }>> = [];
	for (let [handle, at] of [["Rob", 4], ["Jo", 5]] as const) {
		let agreement: Extract<Event, { type: "scoped-choice.agreed" }> = {
			id: `agreement-${handle}`,
			type: "scoped-choice.agreed",
			threadId: "thread-a",
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at,
			source: source(handle, `message-${handle}`, "yep, Lexical for the spike."),
			proposalId: proposal.id,
			cardId,
			optionId,
			label: "Lexical",
			scope: "spike",
		};
		state = applyEvent(state, agreement);
		agreements.push(agreement);
	}
	let saved: Saved = {
		id: "save",
		type: "scoped-choice.saved",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "human",
		actor: { kind: "member", handle: "Rob" },
		at: 6,
		proposalId: proposal.id,
		cardId,
		optionId,
		label: "Lexical",
		scope: "spike",
		supportEventIds: [proposal.id, ...agreements.map(item => item.id)],
		sources: [proposal.source, ...agreements.map(item => item.source)],
		expectedGeneration: 0,
	};
	return { state, proposal, agreements, saved };
}

test("multi-support scoped Save replays exact unique source IDs in event order", () => {
	let { state, proposal, agreements, saved } = fixture();
	let accepted = applyEvent(state, saved);
	expect(restoreState(accepted).events.at(-1)).toEqual(saved);
	let invalid: Saved[] = [
		{ ...saved, supportEventIds: [proposal.id, agreements[0]!.id, agreements[0]!.id] },
		{ ...saved, supportEventIds: [agreements[0]!.id, proposal.id, agreements[1]!.id] },
		{ ...saved, supportEventIds: [proposal.id, "other", agreements[1]!.id] },
		{ ...saved, sources: [agreements[0]!.source, proposal.source, agreements[1]!.source] },
		{ ...saved, sources: [proposal.source, agreements[0]!.source, agreements[0]!.source] },
	];
	for (let item of invalid) expect(() => applyEvent(state, item)).toThrow();
	let quote = "I withdraw my support for Lexical.";
	let withdrawn = applyEvent(state, {
		id: "rob-withdraws",
		type: "stance.changed",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 6,
		source: { ...source("Rob", "rob-withdrawal", quote), role: "withdrawal" },
		scopedProposalId: proposal.id,
		position: "neutral",
	});
	expect(() =>
		applyEvent(withdrawn, {
			...saved,
			observedThreadVersion: withdrawn.threads[0]!.version,
		})
	).toThrow();
});

test("legacy-shaped Save cannot omit a currently active supporter", () => {
	let { state, proposal, agreements, saved } = fixture();
	let stale: Saved = {
		...saved,
		agreementId: agreements[0]!.id,
		sources: [proposal.source, agreements[0]!.source],
	};
	delete stale.supportEventIds;
	expect(() => applyEvent(state, stale)).toThrow();
});

test("legacy-shaped Save cannot include a withdrawn supporter", () => {
	let { state, proposal, agreements, saved } = fixture();
	let quote = "I withdraw my support for Lexical.";
	let withdrawn = applyEvent(state, {
		id: "rob-withdraws-before-legacy-save",
		type: "stance.changed",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 6,
		source: { ...source("Rob", "rob-withdrawal", quote), role: "withdrawal" },
		scopedProposalId: proposal.id,
		position: "neutral",
	});
	let stale: Saved = {
		...saved,
		observedThreadVersion: withdrawn.threads[0]!.version,
		agreementId: agreements[0]!.id,
		sources: [proposal.source, agreements[0]!.source],
	};
	delete stale.supportEventIds;
	expect(() => applyEvent(withdrawn, stale)).toThrow();
});

test("historical proposal-only and proposal-plus-agreement Saves still restore", () => {
	let { state, proposal, agreements, saved } = fixture();
	for (let count of [3, 4]) {
		let historical = initialState();
		for (let event of state.events.slice(0, count)) historical = applyEvent(historical, event);
		let legacy: Saved = {
			...saved,
			observedThreadVersion: historical.threads[0]!.version,
			...(count === 4 ? { agreementId: agreements[0]!.id } : {}),
			sources: count === 4
				? [proposal.source, agreements[0]!.source]
				: [proposal.source],
		};
		delete legacy.supportEventIds;
		let accepted = applyEvent(historical, legacy);
		expect(restoreState(accepted).events.at(-1)).toEqual(legacy);
	}
});
