import type { ConversationPlan } from "@chopin/protocol";
import { isDeepStrictEqual } from "node:util";
import { activeSettleDeferral } from "./preference";
import { activeScopedSupport, currentScopedProposal } from "./event-support";

type Event = Extract<
	ConversationPlan.Event,
	{
		type:
			| "settle.suggested"
			| "settle.agreed"
			| "settle.deferred"
			| "settle.resumed"
			| "scoped-choice.proposed"
			| "scoped-choice.agreed"
			| "scoped-choice.saved";
	}
>;

export function applySettlementEvent(
	next: ConversationPlan.State,
	thread: ConversationPlan.Thread,
	event: Event,
): void {
	switch (event.type) {
		case "settle.suggested":
			if (event.source.role !== "resolution") throw new Error("settle source role disagrees");
			if (event.source.author.kind !== "member") throw new Error("human member required to settle");
			if (thread.status === "decided" || thread.status === "discarded") {
				throw new Error("thread is not open for settling");
			}
			if (
				!thread.contributions.some((item) => item.id === event.optionId && item.kind === "option")
			) {
				throw new Error("unknown settle option");
			}
			if (!activeSettleDeferral(thread, next.events)) {
				thread.pendingSettle = {
					optionId: event.optionId,
					proposer: event.source.author.handle,
					messageId: event.source.messageId,
				};
			}
			break;
		case "settle.agreed":
			if (event.source.role !== "support") throw new Error("agreement source role disagrees");
			if (!thread.pendingSettle) throw new Error("no pending proposal to settle");
			if (thread.pendingSettle.optionId !== event.optionId) {
				throw new Error("agreement names another option");
			}
			if (
				event.source.author.kind !== "member"
				|| event.source.author.handle === thread.pendingSettle.proposer
			) throw new Error("agreement needs another member");
			break;
		case "settle.deferred": {
			let pending = thread.pendingSettle;
			let proposal = next.events.find(item =>
				item.id === event.proposalId && item.type === "settle.suggested"
				&& item.threadId === thread.id
			);
			if (
				!pending || !proposal || proposal.type !== "settle.suggested"
				|| proposal.optionId !== pending.optionId
				|| proposal.source.messageId !== pending.messageId
				|| proposal.source.author.kind !== "member"
				|| proposal.source.author.handle !== pending.proposer
				|| event.source.author.kind !== "member"
				|| event.source.author.handle !== pending.proposer
				|| !next.events.some(item =>
					item.type === "stance.changed" && item.threadId === thread.id
					&& item.source.messageId === event.source.messageId
					&& item.source.author.kind === "member"
					&& item.source.author.handle === pending.proposer
					&& item.optionId === pending.optionId && item.position === "neutral"
				)
				|| activeSettleDeferral(thread, next.events)
			) throw new Error("deferral does not target the active proposal");
			break;
		}
		case "settle.resumed": {
			let deferred = activeSettleDeferral(thread, next.events);
			if (
				!deferred || deferred.id !== event.deferredEventId
				|| deferred.proposalId !== event.proposalId
				|| !thread.pendingSettle || event.source.author.kind !== "member"
			) throw new Error("verification does not target the active deferral");
			break;
		}
		case "scoped-choice.proposed":
			if (
				thread.status === "decided" || thread.status === "discarded"
				|| thread.questionnaireId !== event.cardId
				|| event.source.author.kind !== "member"
			) throw new Error("scoped choice needs an open linked card");
			thread.pendingScopedChoice = {
				proposalId: event.id,
				cardId: event.cardId,
				optionId: event.optionId,
				label: event.label,
				scope: "spike",
				proposer: event.source.author.handle,
				messageId: event.source.messageId,
			};
			break;
		case "scoped-choice.agreed": {
			let pending = thread.pendingScopedChoice;
			let proposal = currentScopedProposal(thread, next.events);
			if (
				thread.status === "decided" || thread.status === "discarded"
				|| !pending || !proposal || proposal.id !== event.proposalId
				|| pending.proposalId !== undefined && pending.proposalId !== event.proposalId
				|| thread.questionnaireId !== event.cardId
				|| pending.cardId !== event.cardId || pending.optionId !== event.optionId
				|| pending.label !== event.label || pending.scope !== event.scope
				|| event.source.author.kind !== "member"
				|| event.source.author.handle === pending.proposer
			) throw new Error("scoped choice agreement does not match the current proposal");
			break;
		}
		case "scoped-choice.saved": {
			let pending = thread.pendingScopedChoice;
			let proposal = currentScopedProposal(thread, next.events);
			let agreement = event.agreementId
				? next.events.find(item => item.id === event.agreementId)
				: undefined;
			let active = proposal ? activeScopedSupport(next.events, proposal) : [];
			let lineageMatches = event.supportEventIds !== undefined
				? active.length > 0
					&& isDeepStrictEqual(event.supportEventIds, active.map(item => item.id))
					&& isDeepStrictEqual(event.sources, active.map(item => item.source))
				: active.length > 0
					&& isDeepStrictEqual(active.map(item => item.id), [
						proposal?.id,
						...(agreement && agreement.type === "scoped-choice.agreed"
							? [agreement.id]
							: []),
					])
					&& isDeepStrictEqual(event.sources, active.map(item => item.source));
			if (
				thread.status === "decided" || thread.status === "discarded"
				|| !pending || !proposal || proposal.id !== event.proposalId
				|| thread.questionnaireId !== event.cardId
				|| pending.cardId !== event.cardId || pending.optionId !== event.optionId
				|| pending.label !== event.label || pending.scope !== event.scope
				|| next.events.some(item =>
					item.type === "scoped-choice.saved" && item.proposalId === event.proposalId
				)
				|| !lineageMatches
				|| event.agreementId !== undefined && (
						agreement?.type !== "scoped-choice.agreed"
						|| agreement.proposalId !== proposal.id || agreement.threadId !== thread.id
						|| agreement.cardId !== event.cardId || agreement.optionId !== event.optionId
						|| agreement.label !== event.label || agreement.scope !== event.scope
					)
			) throw new Error("saved scoped choice does not match the current proposal");
			break;
		}
	}
}
