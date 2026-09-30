import type { ConversationPlan } from "@chopin/protocol";
import { initialState } from "./domain";
import type { EffectDeps } from "./effects";

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.test.ts helpers/data.

export let OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";

export let LATER = "01K0N4W3B7P27CBAEC7A8C8WEB";

export let m7MessageText = "yep, Lexical for the spike. not a final library call yet.";

export function thread(overrides: Partial<ConversationPlan.Thread> = {}): ConversationPlan.Thread {
	return {
		id: "t1",
		question: "Which auth system?",
		questionSources: [],
		questionAuthoring: "quoted",
		status: "exploring",
		contributions: [{
			id: OPTION,
			kind: "option",
			text: "GitHub Apps",
			authoring: "quoted",
			sources: [],
			actor: { kind: "classifier" },
		}],
		stances: [],
		stanceHistory: [],
		decisionHistory: [],
		candidates: [],
		version: 1,
		...overrides,
	};
}

export function event(type: string, id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		type,
		threadId: "t1",
		observedThreadVersion: 1,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1,
		...extra,
	} as ConversationPlan.Event;
}

export function sink(overrides: Partial<EffectDeps> = {}) {
	let receipts = new Set<string>();
	let calls: string[] = [];
	let deps: EffectDeps = {
		applied: key => receipts.has(key),
		markApplied: async key => void receipts.add(key),
		target: () => ({ kind: "open", id: "Q" }),
		insertCard: async () => (calls.push("insert"), "Q"),
		link: async () => void calls.push("link"),
		addOption: async () => void calls.push("option"),
		suggest: async () => void calls.push("suggest"),
		prompt: async () => void calls.push("prompt"),
		report: () => {},
		...overrides,
	};
	return { deps, receipts, calls };
}

export type ScopedProposal = Extract<ConversationPlan.Event, { type: "scoped-choice.proposed" }>;

export type ScopedAgreement = Extract<ConversationPlan.Event, { type: "scoped-choice.agreed" }>;

export let scopedProposal = (): ScopedProposal => ({
	id: "proposal-m6",
	type: "scoped-choice.proposed",
	threadId: "t1",
	observedThreadVersion: 1,
	origin: "classifier",
	actor: { kind: "classifier" },
	at: 6,
	source: {
		messageId: "m6",
		author: { kind: "member", handle: "mei" },
		quote: "I'd pick Lexical for the spike;",
		start: 0,
		end: "I'd pick Lexical for the spike;".length,
		role: "support",
	},
	cardId: "Q",
	optionId: OPTION,
	label: "Lexical",
	scope: "spike",
});

export let scopedAgreement = (proposal: ScopedProposal): ScopedAgreement => ({
	id: "agreement-m7",
	type: "scoped-choice.agreed",
	threadId: proposal.threadId,
	observedThreadVersion: 2,
	origin: "classifier",
	actor: { kind: "classifier" },
	at: 7,
	source: {
		messageId: "m7",
		author: { kind: "member", handle: "rob" },
		quote: m7MessageText.slice(0, 27),
		start: 0,
		end: 27,
		role: "support",
	},
	proposalId: proposal.id,
	cardId: proposal.cardId,
	optionId: proposal.optionId,
	label: proposal.label,
	scope: proposal.scope,
});

export let scopedState = (
	proposal: ScopedProposal,
	...later: ConversationPlan.Event[]
): ConversationPlan.State => ({
	...initialState(),
	events: [proposal, ...later],
	threads: [thread({
		questionnaireId: "Q",
		contributions: [{ ...thread().contributions[0]!, text: "Lexical" }],
		pendingScopedChoice: {
			proposalId: proposal.id,
			cardId: proposal.cardId,
			optionId: proposal.optionId,
			label: proposal.label,
			scope: proposal.scope,
			proposer: "mei",
			messageId: proposal.source.messageId,
		},
	})],
});
