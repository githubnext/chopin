import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Transcript } from "./transcript";
import type { CardMetaStore, QuestionnaireStore } from "@chopin/editor";
import type { Questionnaire } from "@chopin/dialect";
import type { Chat, ConversationPlan, Question } from "@chopin/protocol";
import type { Transport } from "@chopin/question/react";

// Whole fixture declarations from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
// Scoped snapshot options reflect the current card rather than the unrelated auth fixture.
export const questionnaire: Questionnaire = {
	id: "Q",
	by: "mina",
	questions: [{
		id: "auth",
		header: "Auth",
		prompt: "What auth system should we use?",
		multiple: false,
		options: [{ id: "a", label: "Auth0" }, { id: "b", label: "GitHub Apps" }],
	}],
};

export function prompt(id: string, generation: number): Chat.Entry {
	return {
		author: { kind: "system" },
		id,
		text: "Ready to decide: What auth system should we use?",
		ts: 1_700_000_000,
		decision: { questionnaireId: "Q", kind: "prompt", generation },
	};
}

export let proposalSource: ConversationPlan.SourceRef = {
	messageId: "m6",
	author: { kind: "member", handle: "mei" },
	quote: "I'd pick Lexical for the spike;",
	start: 0,
	end: "I'd pick Lexical for the spike;".length,
	role: "support",
};

export let agreementSource: ConversationPlan.SourceRef = {
	messageId: "m7",
	author: { kind: "member", handle: "rob" },
	quote: "yep, Lexical for the spike.",
	start: 0,
	end: "yep, Lexical for the spike.".length,
	role: "support",
};

export let proposal: ConversationPlan.Event = {
	id: "proposal-m6",
	type: "scoped-choice.proposed",
	threadId: "thread-a",
	observedThreadVersion: 2,
	origin: "classifier",
	actor: { kind: "classifier" },
	at: 1_700_000_000,
	source: proposalSource,
	cardId: "Q",
	optionId: "lexical",
	label: "Lexical",
	scope: "spike",
};

export let agreement: ConversationPlan.Event = {
	id: "agreement-m7",
	type: "scoped-choice.agreed",
	threadId: "thread-a",
	observedThreadVersion: 3,
	origin: "classifier",
	actor: { kind: "classifier" },
	at: 1_700_000_001,
	source: agreementSource,
	proposalId: proposal.id,
	cardId: "Q",
	optionId: "lexical",
	label: "Lexical",
	scope: "spike",
};

export let saved: ConversationPlan.Event = {
	id: "saved-m8",
	type: "scoped-choice.saved",
	threadId: "thread-a",
	observedThreadVersion: 4,
	origin: "human",
	actor: { kind: "member", handle: "ana" },
	at: 1_700_000_002,
	proposalId: proposal.id,
	cardId: "Q",
	optionId: "lexical",
	label: "Lexical",
	scope: "spike",
	sources: [proposalSource],
	expectedGeneration: 0,
};

export let scopedNotice = (sources: ConversationPlan.SourceRef[]): Chat.Entry => ({
	author: { kind: "system" },
	id: `scoped-${sources.at(-1)?.messageId}`,
	text: "A scoped choice is ready to save.",
	ts: 1_700_000_001,
	decision: {
		questionnaireId: "Q",
		kind: "scoped-choice",
		threadId: "thread-a",
		proposalId: "proposal-m6",
		cardId: "Q",
		optionId: "lexical",
		label: "Lexical",
		scope: "spike",
		generation: 0,
		triggerEventId: sources.length === 1 ? "proposal-m6" : "agreement-m7",
		sources,
	},
});

export let scopedPlan = (
	events: ConversationPlan.Event[],
	effectiveOptionLabel = "Lexical",
): ConversationPlan.State => ({
	schemaVersion: 1,
	revision: events.length,
	events,
	threads: [{
		id: "thread-a",
		question: "Which library should we spike?",
		questionSources: [],
		questionAuthoring: "quoted",
		status: "exploring",
		contributions: [{
			id: "lexical",
			kind: "option",
			text: "Lexical",
			...(effectiveOptionLabel === "Lexical" ? {} : { displayLabel: effectiveOptionLabel }),
			authoring: "quoted",
			sources: [],
			actor: { kind: "classifier" },
		}],
		stances: [],
		stanceHistory: [],
		decisionHistory: [],
		candidates: [],
		questionnaireId: "Q",
		pendingScopedChoice: {
			proposalId: "proposal-m6",
			cardId: "Q",
			optionId: "lexical",
			label: "Lexical",
			scope: "spike",
			proposer: "mei",
			messageId: "m6",
		},
		version: 3,
	}],
	queue: [],
	analysis: [],
	researchOffers: [],
});

export function scopedTranscriptMarkup(entry: Chat.Entry, state: ConversationPlan.State) {
	let questions = {
		subscribe: () => () => {},
		snapshot: () => [{
			id: "Q",
			value: {
				...questionnaire,
				questions: [{
					...questionnaire.questions[0]!,
					options: [{
						id: "lexical",
						label: state.threads[0]!.contributions[0]!.displayLabel ?? "Lexical",
					}],
				}],
			},
		}],
	} as unknown as QuestionnaireStore;
	let cardMeta: Question.CardMeta = {
		status: "open",
		origin: "conversation",
		involved: [],
		history: [],
		optionOrigins: {},
		hasProse: false,
		refining: false,
		proseOrphaned: false,
	};
	let meta = {
		subscribe: () => () => {},
		snapshot: () => new Map([["Q", cardMeta]]),
	} as unknown as CardMetaStore;
	return renderToStaticMarkup(createElement(Transcript, {
		active: true,
		canEdit: true,
		conversationPlan: state,
		decisions: {
			questions,
			meta,
			wire: {
				ask: async () => undefined as never,
				send() {},
				on: () => () => {},
			} as Transport,
			connected: true,
			canEdit: true,
			onOpenCard() {},
		},
		entries: [entry],
		handle: "ana",
		onWithdraw: () => {},
		queued: [],
	}));
}
