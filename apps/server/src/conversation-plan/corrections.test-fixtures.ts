import type { Chat, ConversationPlan } from "@chopin/protocol";
import { applyCorrection, applyInference } from "./domain";
import { QUESTION_SET_VERSION } from "./questions";

// Exact actor/helper declarations: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/corrections.test.ts.
export let alice = { kind: "member", handle: "alice" } as const;
export let bob = { kind: "member", handle: "bob" } as const;

export function message(id: string, text: string): Chat.Entry {
	return { id, text, author: alice, ts: 1 };
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

export function open(state: ConversationPlan.State, threadId = "t1"): ConversationPlan.State {
	let entry = message(`open-${threadId}`, `Which option for ${threadId}?`);
	return applyInference(state, {
		id: `open-event-${threadId}`,
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

export function add(
	state: ConversationPlan.State,
	kind: "option" | "reason" | "constraint",
	id: string,
	targetId?: string,
	threadId = "t1",
): ConversationPlan.State {
	let entry = message(`message-${id}`, `Words for ${id}`);
	return applyInference(state, {
		id: `event-${id}`,
		type: `${kind}.added`,
		threadId,
		observedThreadVersion: state.threads.find((thread) => thread.id === threadId)!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 2,
		source: source(entry, kind),
		contribution: { id, text: entry.text, authoring: "quoted", targetId, relation: "qualifies" },
	}, entry);
}

export function stance(
	state: ConversationPlan.State,
	id: string,
	optionId?: string,
): ConversationPlan.State {
	let entry = message(`message-${id}`, `I object to ${optionId ?? "the thread"}.`);
	return applyInference(state, {
		id,
		type: "stance.changed",
		threadId: "t1",
		observedThreadVersion: state.threads[0].version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 3,
		source: source(entry, "objection"),
		optionId,
		position: "oppose",
	}, entry);
}

export function correct(
	state: ConversationPlan.State,
	actionId: string,
	change: ConversationPlan.CorrectionChange,
	expectedVersion = state.threads[0].version,
): ConversationPlan.State {
	return applyCorrection(state, { actionId, threadId: "t1", expectedVersion, change }, bob, 10);
}

export function reviewedExcerpt(
	state: ConversationPlan.State,
	entry: Chat.Entry,
	start: number,
	end: number,
	status: "review" | "ignored" = "review",
): ConversationPlan.State {
	return {
		...state,
		revision: state.revision + 1,
		analysis: [...state.analysis, {
			messageId: entry.id,
			questionSetVersion: QUESTION_SET_VERSION,
			modelVersion: "jev-test",
			status: "unlinked",
			passes: [],
			eventIds: [],
			outcomes: [{ start, end, status, gate: "unclassified excerpt", eventIds: [] }],
		}],
	};
}

export function correctExcerpt(
	state: ConversationPlan.State,
	action: ConversationPlan.CorrectionAction,
	entry: Chat.Entry,
): ConversationPlan.State {
	let apply = applyCorrection as unknown as (
		state: ConversationPlan.State,
		action: ConversationPlan.CorrectionAction,
		actor: typeof bob,
		at: number,
		messages: readonly Chat.Entry[],
	) => ConversationPlan.State;
	return apply(state, action, bob, 10, [entry]);
}
