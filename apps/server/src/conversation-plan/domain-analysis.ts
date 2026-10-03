import type { Chat, ConversationPlan } from "@chopin/protocol";
import { initialState } from "./domain-initial";
import { applyEvent } from "./events";
import { validateSource } from "./sources";
import { assertStateShape, MAX_ANALYSIS, MAX_QUEUE } from "./validation";

type State = ConversationPlan.State;
type Event = ConversationPlan.Event;

export function enqueue(state: State, messageId: string): State {
	if (!messageId || messageId.length > 200) throw new Error("invalid message ID");
	if (state.queue.some((item) => item.messageId === messageId)) return state;
	if (state.queue.length >= MAX_QUEUE) throw new Error("conversation analysis queue is full");
	return {
		...state,
		revision: state.revision + 1,
		queue: [...state.queue, { messageId, status: "pending", attempts: 0 }],
	};
}

export function retryMessage(state: State, messageId: string): State {
	let index = state.queue.findIndex((item) => item.messageId === messageId);
	if (index < 0 || state.queue[index].status !== "failed") throw new Error("message is not failed");
	let queue = state.queue.map((item, i) =>
		i === index
			? { messageId, status: "pending" as const, attempts: item.attempts + 1 }
			: item
	);
	return { ...state, revision: state.revision + 1, queue };
}

export function replay(events: readonly Event[]): State {
	let state = initialState();
	for (let event of events) state = applyEvent(state, event);
	return state;
}

export function applyInference(state: State, event: Event, message: Chat.Entry): State {
	if (state.events.some((accepted) => accepted.id === event.id)) return state;
	if (event.origin === "human") throw new Error("human events require authenticated correction");
	if (
		event.type === "decision.recorded" || event.type === "decision.reopened"
		|| (event.type === "candidate.proposed" && event.candidate.kind === "resolution")
	) {
		throw new Error("decisions are recorded on the card");
	}
	if (!("source" in event) || !event.source) throw new Error("inference needs a source");
	validateSource(event.source, message);
	return applyEvent(state, event);
}

export function completeAnalysis(
	state: State,
	messageId: string,
	events: readonly Event[],
	message: Chat.Entry,
	analysis: Omit<ConversationPlan.AnalysisRecord, "messageId" | "eventIds">,
): State {
	let queued = state.queue.find((item) => item.messageId === messageId);
	if (message.id !== messageId || !queued || queued.status === "failed") {
		throw new Error("conversation analysis message is not queued");
	}
	if (events.length > 12) throw new Error("too many events from one message");
	if (!["applied", "unlinked", "failed"].includes(analysis.status)) {
		throw new Error("analysis is not terminal");
	}
	if (analysis.status !== "applied" && events.length > 0) {
		throw new Error("non-applied analysis has events");
	}
	let next = state;
	for (let event of events) {
		if (!("source" in event) || event.source?.messageId !== messageId) {
			throw new Error("analysis event belongs to another message");
		}
		next = applyInference(next, event, message);
	}
	let eventIds = events.filter((event) => next.events.some((accepted) => accepted.id === event.id))
		.map((event) => event.id);
	let record: ConversationPlan.AnalysisRecord = {
		...structuredClone(analysis),
		messageId,
		eventIds,
	};
	let history = [...next.analysis.filter((item) => item.messageId !== messageId), record].slice(
		-MAX_ANALYSIS,
	);
	let queue = analysis.status === "failed"
		? next.queue.map((item) =>
			item.messageId === messageId
				? { ...item, status: "failed" as const, error: analysis.error?.slice(0, 300) }
				: item
		)
		: next.queue.filter((item) => item.messageId !== messageId);
	let completed = { ...next, revision: next.revision + 1, queue, analysis: history };
	assertStateShape(completed);
	return completed;
}
