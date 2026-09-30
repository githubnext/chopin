import type { ConversationPlan } from "@chopin/protocol";

type Event = ConversationPlan.Event;

export function currentScopedProposal(
	thread: ConversationPlan.Thread,
	events: readonly Event[],
): Extract<Event, { type: "scoped-choice.proposed" }> | undefined {
	let pending = thread.pendingScopedChoice;
	if (!pending) return;
	let matches = events.filter((
		event,
	): event is Extract<Event, { type: "scoped-choice.proposed" }> =>
		event.type === "scoped-choice.proposed" && event.threadId === thread.id
		&& event.cardId === pending.cardId && event.optionId === pending.optionId
		&& event.label === pending.label && event.scope === pending.scope
		&& event.source.messageId === pending.messageId
		&& event.source.author.kind === "member"
		&& event.source.author.handle === pending.proposer
	);
	return pending.proposalId
		? matches.find(event => event.id === pending.proposalId)
		: matches.length === 1
		? matches[0]
		: undefined;
}

/** An absent link preserves previously persisted optionless stance behavior. */
export function targetsScopedProposal(
	event: Extract<Event, { type: "stance.changed" }>,
	proposalId: string | undefined,
	optionId: string,
): boolean {
	if (event.position === "support" || event.scopedProposalId === null) return false;
	if (event.optionId !== undefined && event.optionId !== optionId) return false;
	return event.scopedProposalId === undefined || event.scopedProposalId === proposalId;
}

type ScopedSupportEvent = Extract<Event, {
	type: "scoped-choice.proposed" | "scoped-choice.agreed";
}>;

/** Accepted support in event order, with each member's latest active source. */
export function activeScopedSupport(
	events: readonly Event[],
	proposal: Extract<Event, { type: "scoped-choice.proposed" }>,
): ScopedSupportEvent[] {
	let start = events.findIndex(item => item.id === proposal.id);
	if (start < 0 || proposal.source.author.kind !== "member") return [];
	let active = new Map<string, ScopedSupportEvent>();
	for (let item of events.slice(start)) {
		if (item.id === proposal.id) {
			active.set(proposal.source.author.handle, proposal);
		} else if (
			item.type === "scoped-choice.agreed" && item.threadId === proposal.threadId
			&& item.proposalId === proposal.id && item.cardId === proposal.cardId
			&& item.optionId === proposal.optionId && item.label === proposal.label
			&& item.scope === proposal.scope && item.source.author.kind === "member"
		) {
			active.delete(item.source.author.handle);
			active.set(item.source.author.handle, item);
		} else if (
			item.type === "stance.changed" && item.threadId === proposal.threadId
			&& item.source.author.kind === "member"
			&& targetsScopedProposal(item, proposal.id, proposal.optionId)
		) active.delete(item.source.author.handle);
	}
	return [...active.values()];
}
