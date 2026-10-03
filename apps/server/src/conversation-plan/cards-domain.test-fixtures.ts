import type { Chat, ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";

export let optionId = "01K0N4W3B7P27CBAEC7A8C8WEA";
export let jules: Chat.Entry = {
	id: "m1",
	author: { kind: "member", handle: "jules" },
	text: "What auth system should we use?",
	ts: 1,
};
export let mina: Chat.Entry = {
	id: "m2",
	author: { kind: "member", handle: "mina" },
	text: "Let's use GitHub Apps.",
	ts: 2,
};
export let julesAgrees: Chat.Entry = {
	id: "m3",
	author: { kind: "member", handle: "jules" },
	text: "Sounds good to me.",
	ts: 3,
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

export function base(
	id: string,
	version: number,
	origin: "classifier" | "human" | "planner" = "classifier",
): ConversationPlan.EventBase {
	return {
		id,
		threadId: "t1",
		observedThreadVersion: version,
		origin,
		actor: origin === "human"
			? { kind: "member", handle: "mina" }
			: origin === "planner"
			? { kind: "agent" }
			: { kind: "classifier" },
		at: 3,
	};
}

export function withOption(): ConversationPlan.State {
	let state = applyInference(initialState(), {
		...base("open", 0),
		type: "thread.opened",
		source: source(jules, "question"),
		question: jules.text,
	}, jules);
	let optionMessage: Chat.Entry = { ...jules, id: "option-message", text: "GitHub Apps" };
	return applyInference(state, {
		...base("option", 1),
		type: "option.added",
		source: source(optionMessage, "option"),
		contribution: { id: optionId, text: optionMessage.text, authoring: "quoted" },
	}, optionMessage);
}

export function withPendingSettle(): ConversationPlan.State {
	return applyInference(withOption(), {
		...base("settle", 2),
		type: "settle.suggested",
		source: source(mina, "resolution"),
		optionId,
	}, mina);
}
