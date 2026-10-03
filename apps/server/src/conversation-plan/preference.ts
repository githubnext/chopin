import type { ConversationPlan } from "@chopin/protocol";

type Event = ConversationPlan.Event;
type Thread = ConversationPlan.Thread;

/** A later suggestion cannot override an unmet verification gate. */
export function activeSettleDeferral(
	thread: Thread,
	events: readonly Event[],
): Extract<Event, { type: "settle.deferred" }> | undefined {
	if (thread.status === "decided" || thread.status === "discarded") return;
	let deferred = events.findLast((event): event is Extract<Event, { type: "settle.deferred" }> =>
		event.type === "settle.deferred" && event.threadId === thread.id
	);
	if (!deferred) return;
	return events.some(event =>
			event.type === "settle.resumed" && event.threadId === thread.id
			&& event.proposalId === deferred.proposalId && event.deferredEventId === deferred.id
		)
		? undefined
		: deferred;
}

/** A historical proposal remains on the thread for replay, even after its source withdraws. */
export function effectivePending(
	thread: Thread,
	events: readonly Event[],
): Thread["pendingSettle"] {
	let pending = thread.pendingSettle;
	if (!pending || thread.status === "decided" || thread.status === "discarded") return;
	if (activeSettleDeferral(thread, events)) return;
	let proposedAt = events.findLastIndex(event =>
		event.threadId === thread.id && event.type === "settle.suggested"
		&& event.optionId === pending.optionId
		&& event.source.messageId === pending.messageId
		&& event.source.author.kind === "member"
		&& event.source.author.handle === pending.proposer
	);
	if (proposedAt < 0) return pending;
	let resumedAt = events.findLastIndex(event =>
		event.type === "settle.resumed" && event.threadId === thread.id
	);
	let withdrawn = events.slice(proposedAt + 1).some(event =>
		event.threadId === thread.id && event.type === "stance.changed"
		&& event.position !== "support" && event.optionId === pending.optionId
		&& event.source.author.kind === "member"
		&& event.source.author.handle === pending.proposer
		&& events.indexOf(event) > resumedAt
	);
	return withdrawn ? undefined : pending;
}

/** Keep only independently valid sources for the latest pending settle proposal. */
export function effectivePreference(
	thread: Thread,
	events: readonly Event[],
): { optionId: string; messageIds: string[] } | undefined {
	let pending = thread.pendingSettle;
	if (!pending || thread.status === "decided" || thread.status === "discarded") return;
	if (activeSettleDeferral(thread, events)) return;
	let proposedAt = events.findLastIndex(event =>
		event.threadId === thread.id && event.type === "settle.suggested"
		&& event.optionId === pending.optionId
		&& event.source.messageId === pending.messageId
		&& event.source.author.kind === "member"
		&& event.source.author.handle === pending.proposer
	);
	if (proposedAt < 0) return { optionId: pending.optionId, messageIds: [pending.messageId] };
	let resumedAt = events.findLastIndex(event =>
		event.type === "settle.resumed" && event.threadId === thread.id
	);
	let sources = events.slice(proposedAt).filter(event =>
		event.threadId === thread.id
		&& (event.type === "settle.suggested" && event === events[proposedAt]
			|| event.type === "settle.agreed" && event.optionId === pending.optionId)
	);
	let messageIds = sources.flatMap(source => {
		if (source.type !== "settle.suggested" && source.type !== "settle.agreed") return [];
		if (source.source.author.kind !== "member") return [];
		let actor = source.source.author.handle;
		let sourceAt = events.indexOf(source);
		let withdrawn = events.slice(sourceAt + 1).some(event =>
			event.threadId === thread.id && event.type === "stance.changed"
			&& event.position !== "support" && event.optionId === pending.optionId
			&& event.source.author.kind === "member" && event.source.author.handle === actor
			&& events.indexOf(event) > resumedAt
		);
		return withdrawn ? [] : [source.source.messageId];
	});
	messageIds = [...new Set(messageIds)];
	return messageIds.length
		? { optionId: pending.optionId, messageIds: messageIds.slice(-8) }
		: undefined;
}
