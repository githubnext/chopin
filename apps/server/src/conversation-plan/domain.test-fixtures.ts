import type { Chat, ConversationPlan } from "@chopin/protocol";

export let alice: Chat.Entry = {
	id: "m1",
	author: { kind: "member", handle: "alice" },
	text: "Should we start with an outline?",
	ts: 1,
};
export let bob: Chat.Entry = {
	id: "m2",
	author: { kind: "member", handle: "bob" },
	text: "I prefer an optional outline.",
	ts: 2,
};

export function source(
	message: Chat.Entry,
	role: ConversationPlan.SourceRole,
): ConversationPlan.SourceRef {
	return {
		messageId: message.id,
		author: message.author as ConversationPlan.SourceAuthor,
		quote: message.text,
		start: 0,
		end: message.text.length,
		role,
	};
}

export function opened(): Extract<ConversationPlan.Event, { type: "thread.opened" }> {
	return {
		id: "m1:0:thread.opened:v1",
		type: "thread.opened",
		threadId: "t1",
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1,
		source: source(alice, "question"),
		question: "Should we start with an outline?",
	};
}

export function option(state: ConversationPlan.State): ConversationPlan.Event {
	return {
		id: "m2:0:option.added:v1",
		type: "option.added",
		threadId: "t1",
		observedThreadVersion: state.threads[0].version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 2,
		source: source(bob, "option"),
		contribution: {
			id: "o1",
			text: "Optional outline",
			authoring: "scribe",
		},
	};
}
