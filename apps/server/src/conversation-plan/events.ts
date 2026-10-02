import type { ConversationPlan } from "@chopin/protocol";
import { assertEventShape, MAX_EVENTS, MAX_THREADS } from "./validation";
import { applyContributionEvent } from "./event-contributions";
import { applyLifecycleEvent } from "./event-lifecycle";
import { applySettlementEvent } from "./event-settlement";
import { applyCorrectionEvent } from "./event-corrections";

export { activeScopedSupport, currentScopedProposal, targetsScopedProposal } from "./event-support";

type State = ConversationPlan.State;
type Event = ConversationPlan.Event;

export class ConversationCapacityError extends Error {
	constructor() {
		super("Conversation history is full");
	}
}

/** Durable card actions reserve the event slots their FIFO mirror will need. */
export function assertEventCapacity(state: State, reserved: number): void {
	if (state.events.length + reserved > MAX_EVENTS) throw new ConversationCapacityError();
}

/** One accepted event changes a cloned view; callers persist the returned state. */
export function applyEvent(state: State, event: Event): State {
	if (state.events.some((accepted) => accepted.id === event.id)) return state;
	assertEventShape(event);
	event = structuredClone(event);
	assertEventCapacity(state, 1);
	let existing = state.threads.find((thread) => thread.id === event.threadId);
	if (event.type === "thread.opened") {
		if (existing || event.observedThreadVersion !== 0) throw new Error("stale thread opening");
		if (state.threads.length >= MAX_THREADS) throw new Error("conversation thread limit reached");
		if (event.source && event.source.role !== "question") {
			throw new Error("opening requires a question source");
		}
		let thread: ConversationPlan.Thread = {
			id: event.threadId,
			question: event.question,
			questionSources: event.source ? [event.source] : [],
			questionAuthoring: event.source && event.question === event.source.quote
				? "quoted"
				: "scribe",
			status: "exploring",
			contributions: [],
			stances: [],
			stanceHistory: [],
			decisionHistory: [],
			candidates: [],
			version: 1,
		};
		return {
			...state,
			revision: state.revision + 1,
			events: [...state.events, event],
			threads: [...state.threads, thread],
		};
	}
	if (!existing || existing.version !== event.observedThreadVersion) {
		throw new Error("stale conversation thread version");
	}
	let next = structuredClone(state);
	let thread = next.threads.find((item) => item.id === event.threadId)!;
	switch (event.type) {
		case "option.added":
		case "reason.added":
		case "constraint.added":
		case "stance.changed":
		case "option.relabeled":
			applyContributionEvent(next, thread, event);
			break;
		case "thread.leaning":
		case "decision.recorded":
		case "decision.reopened":
		case "candidate.proposed":
		case "candidate.confirmed":
		case "candidate.rejected":
		case "card.linked":
		case "thread.discarded":
			applyLifecycleEvent(thread, event);
			break;
		case "settle.suggested":
		case "settle.agreed":
		case "settle.deferred":
		case "settle.resumed":
		case "scoped-choice.proposed":
		case "scoped-choice.agreed":
		case "scoped-choice.saved":
			applySettlementEvent(next, thread, event);
			break;
		case "card.corrected":
			applyCorrectionEvent(next, thread, event);
			break;
	}
	thread.version++;
	next.revision++;
	next.events.push(event);
	return next;
}
