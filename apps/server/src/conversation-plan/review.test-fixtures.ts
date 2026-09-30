import type { Chat, ConversationPlan } from "@chopin/protocol";
import { applyCorrection, applyInference } from "./domain";
import { applyEvent } from "./events";

// Exact actor/helper declarations: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/review.test.ts.
export let alice = { kind: "member", handle: "alice" } as const;
export let bob = { kind: "member", handle: "bob" } as const;

export function message(id: string, text: string, author: Chat.Author = alice): Chat.Entry {
	return { id, text, author, ts: 1 };
}

export function source(
	entry: Chat.Entry,
	role: ConversationPlan.SourceRole,
): ConversationPlan.SourceRef {
	return {
		messageId: entry.id,
		author: entry.author as ConversationPlan.SourceAuthor,
		quote: entry.text,
		start: 0,
		end: entry.text.length,
		role,
	};
}

export function open(
	state: ConversationPlan.State,
	threadId = "t1",
	entry = message(`question-${threadId}`, `Should we use ${threadId}?`),
): ConversationPlan.State {
	return applyInference(state, {
		id: `open-${threadId}`,
		type: "thread.opened",
		threadId,
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1,
		source: source(entry, "question"),
		question: entry.text,
	}, entry);
}

export function addOption(
	state: ConversationPlan.State,
	threadId: string,
	optionId: string,
): ConversationPlan.State {
	let entry = message(`option-${optionId}`, `Option ${optionId}`);
	let thread = state.threads.find((item) => item.id === threadId)!;
	return applyInference(state, {
		id: `add-${optionId}`,
		type: "option.added",
		threadId,
		observedThreadVersion: thread.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 2,
		source: source(entry, "option"),
		contribution: { id: optionId, text: entry.text, authoring: "quoted" },
	}, entry);
}

export function decide(state: ConversationPlan.State, optionId?: string): ConversationPlan.State {
	return applyEvent(state, {
		id: "resolve-event",
		type: "decision.recorded",
		threadId: "t1",
		observedThreadVersion: state.threads[0].version,
		origin: "human",
		actor: bob,
		at: 3,
		text: "Do that",
		optionId,
		explicit: true,
	});
}

export function correct(
	state: ConversationPlan.State,
	actionId: string,
	threadId: string,
	change: ConversationPlan.CorrectionChange,
	author: typeof alice | typeof bob = bob,
): ConversationPlan.State {
	let thread = state.threads.find((item) => item.id === threadId)!;
	return applyCorrection(
		state,
		{
			actionId,
			threadId,
			expectedVersion: thread.version,
			change,
		},
		author,
		4,
	);
}
