import type { Chat, ConversationPlan } from "@chopin/protocol";

import type { Plan } from "./plan/service";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
export const d02ProposalText = "We should use the VPS for the beta.";

export const d02DeferralText =
	"I take back my VPS preference for now. Let’s verify backups before choosing hosting.";

export const d02DeferralQuote = "Let’s verify backups before choosing hosting.";

export function d02Source(
	messageId: string,
	handle: string,
	text: string,
	role: ConversationPlan.SourceRole,
): ConversationPlan.SourceRef {
	let start = text === d02DeferralQuote ? d02DeferralText.indexOf(text) : 0;
	return {
		messageId,
		author: { kind: "member", handle },
		quote: text,
		start,
		end: start + text.length,
		role,
	};
}

export function d02Settlement(plan: Plan, cardId: string) {
	let record = plan.records.get(cardId);
	let threadId = record?.threadId;
	let thread = plan.conversationPlan.threads.find(item => item.id === threadId);
	let optionId = record?.definition.questions[0]?.options[0]?.id;
	if (!record || !threadId || !thread || !optionId) {
		throw new Error("D02 settlement test needs a linked open card");
	}
	let proposal = {
		id: "d02:settle-m5",
		type: "settle.suggested",
		threadId,
		observedThreadVersion: thread.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 5,
		source: d02Source("m5", "Bram", d02ProposalText, "resolution"),
		optionId,
	} as unknown as ConversationPlan.Event;
	let deferral = {
		id: "d02:settle-deferred-m7",
		type: "settle.deferred",
		threadId,
		observedThreadVersion: thread.version + 1,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 7,
		proposalId: proposal.id,
		source: d02Source("m7", "Bram", d02DeferralQuote, "constraint"),
	} as unknown as ConversationPlan.Event;
	let pendingSettle = { optionId, proposer: "Bram", messageId: "m5" };
	let transcript: Chat.Entry[] = [
		{
			id: "m5",
			author: { kind: "member", handle: "Bram" },
			text: d02ProposalText,
			ts: 5,
		},
		{
			id: "m7",
			author: { kind: "member", handle: "Bram" },
			text: d02DeferralText,
			ts: 7,
		},
		{
			id: "d02:save-prompt",
			author: { kind: "system" },
			text: "Ready to decide: Where should the beta be hosted?",
			ts: 8,
			decision: {
				questionnaireId: cardId,
				kind: "prompt",
				generation: record.history.length,
				sourceMessageIds: ["m5"],
				suggestedOptionId: optionId,
			},
		},
	];
	plan.chat.entries.push(...transcript);
	plan.conversationPlan = {
		...plan.conversationPlan,
		events: [...plan.conversationPlan.events, proposal],
		threads: plan.conversationPlan.threads.map(item =>
			item.id === threadId
				? { ...item, version: thread.version + 1, pendingSettle }
				: item
		),
	};
	return { proposal, deferral, transcript, optionId, threadId };
}

export function activateD02Deferral(plan: Plan, deferral: ConversationPlan.Event): void {
	plan.conversationPlan = {
		...plan.conversationPlan,
		events: [...plan.conversationPlan.events, deferral],
		threads: plan.conversationPlan.threads.map(thread =>
			thread.id === deferral.threadId
				? { ...thread, version: thread.version + 1 }
				: thread
		),
	};
}
