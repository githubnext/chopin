import type { Chat, ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";
import { applyEvent } from "./events";

import { createProcessor } from "./service";
import { entry, harness, opened } from "./service.test-fixtures";

// Exact helpers from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
export function scopedSaveFixture(withAgreement = false) {
	let cardId = "01K0N4W3B7P27CBAEC7A8C8WEA";
	let optionId = "01K0N4W3B7P27CBAEC7A8C8WEB";
	let seed = entry("save-seed", "Which editor should we use?");
	let m6: Chat.Entry = {
		...entry(
			"save-m6",
			"agreed. I'd pick Lexical for the spike; still want to see how it handles pasted tables.",
		),
		author: { kind: "member", handle: "Mei" },
		ts: 1001,
	};
	let m7: Chat.Entry = {
		...entry("save-m7", "yep, Lexical for the spike. not a final library call yet."),
		author: { kind: "member", handle: "Rob" },
		ts: 1002,
	};
	let state = applyInference(initialState(), opened(seed), seed);
	state = applyEvent(state, {
		id: "save-link-spike",
		type: "card.linked",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: seed.ts,
		questionnaireId: cardId,
	});
	let proposal: ConversationPlan.Event = {
		id: "save-proposal-m6",
		type: "scoped-choice.proposed",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: m6.ts,
		source: {
			messageId: m6.id,
			author: m6.author as ConversationPlan.SourceAuthor,
			quote: "I'd pick Lexical for the spike;",
			start: 8,
			end: 39,
			role: "support",
		},
		cardId,
		optionId,
		label: "Lexical",
		scope: "spike",
	};
	state = applyInference(state, proposal, m6);
	let agreement: ConversationPlan.Event = {
		id: "save-agreement-m7",
		type: "scoped-choice.agreed",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: m7.ts,
		source: {
			messageId: m7.id,
			author: m7.author as ConversationPlan.SourceAuthor,
			quote: "yep, Lexical for the spike.",
			start: 0,
			end: 27,
			role: "support",
		},
		proposalId: proposal.id,
		cardId,
		optionId,
		label: "Lexical",
		scope: "spike",
	};
	if (withAgreement) state = applyInference(state, agreement, m7);
	let setup = harness();
	setup.plan.chat.entries.push(seed, m6, ...(withAgreement ? [m7] : []));
	setup.plan.conversationPlan = state;
	setup.plan.records.set(cardId, {
		id: cardId,
		threadId: "thread-a",
		status: "open",
		history: [],
		definition: { questions: [{ options: [{ id: optionId, label: "Lexical" }] }] },
	} as never);
	return { setup, cardId, optionId, proposal, agreement, m6, m7 };
}

export function addScopedSupport(
	fixture: ReturnType<typeof scopedSaveFixture>,
	handle: string,
	messageId: string,
	agreementId: string,
) {
	let message = entry(messageId, "yep, Lexical for the spike.");
	message.author = { kind: "member", handle };
	message.ts = 1003;
	let thread = fixture.setup.plan.conversationPlan.threads[0]!;
	let agreement: ConversationPlan.Event = {
		id: agreementId,
		type: "scoped-choice.agreed",
		threadId: thread.id,
		observedThreadVersion: thread.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: message.ts,
		source: {
			messageId: message.id,
			author: message.author as ConversationPlan.SourceAuthor,
			quote: message.text,
			start: 0,
			end: message.text.length,
			role: "support",
		},
		proposalId: fixture.proposal.id,
		cardId: fixture.cardId,
		optionId: fixture.optionId,
		label: "Lexical",
		scope: "spike",
	};
	fixture.setup.plan.conversationPlan = applyInference(
		fixture.setup.plan.conversationPlan,
		agreement,
		message,
	);
	fixture.setup.plan.chat.entries.push(message);
	return { agreement, message };
}

export function retractScopedSupport(
	fixture: ReturnType<typeof scopedSaveFixture>,
	handle: string,
	messageId: string,
) {
	let message = entry(messageId, "I withdraw my support for Lexical for the spike.");
	message.author = { kind: "member", handle };
	message.ts = 1004;
	let thread = fixture.setup.plan.conversationPlan.threads[0]!;
	let retraction: ConversationPlan.Event = {
		id: `${messageId}:stance`,
		type: "stance.changed",
		scopedProposalId: fixture.proposal.id,
		threadId: thread.id,
		observedThreadVersion: thread.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: message.ts,
		source: {
			messageId: message.id,
			author: message.author as ConversationPlan.SourceAuthor,
			quote: message.text,
			start: 0,
			end: message.text.length,
			role: "withdrawal",
		},
		position: "neutral",
	};
	fixture.setup.plan.conversationPlan = applyInference(
		fixture.setup.plan.conversationPlan,
		retraction,
		message,
	);
	fixture.setup.plan.chat.entries.push(message);
	return { retraction, message };
}

export type ScopedChoiceSaveInput = {
	actionId: string;
	threadId: string;
	expectedVersion: number;
	proposalId: string;
	cardId: string;
	optionId: string;
	expectedLabel: string;
	expectedGeneration: number;
};

export async function saveScopedChoice(
	processor: ReturnType<typeof createProcessor>,
	input: ScopedChoiceSaveInput,
	actor = { kind: "member", handle: "Rob" } as Extract<Chat.Author, { kind: "member" }>,
) {
	let saver = processor as unknown as {
		saveScopedChoice(
			input: ScopedChoiceSaveInput,
			actor: Extract<Chat.Author, { kind: "member" }>,
		): Promise<{ eventId: string; revision: number }>;
	};
	return saver.saveScopedChoice(input, actor);
}

export function scopedChoiceSaveInput(
	fixture: ReturnType<typeof scopedSaveFixture>,
	actionId = "save-spike-choice",
): ScopedChoiceSaveInput {
	return {
		actionId,
		threadId: "thread-a",
		expectedVersion: fixture.setup.plan.conversationPlan.threads[0]!.version,
		proposalId: fixture.proposal.id,
		cardId: fixture.cardId,
		optionId: fixture.optionId,
		expectedLabel: "Lexical",
		expectedGeneration: 0,
	};
}
