import type { CandidateEntry } from "./policy-candidate-entry";
import { createCandidateFactories } from "./policy-candidate-factories";
import type { CandidateRole } from "./policy-candidate-role";
import type { PolicyContext } from "./policy-context";
import type { Event } from "./policy-types";
import { noul } from "./policy-scoring";

/** Invoke only for its matching captured role; undefined skips, a result continues without application. */
export function runWithdrawal(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
): { proposed: Event | undefined } | undefined {
	let { message } = context;
	let { candidate, outcome } = entry;
	let { pending, thread, option } = frame;
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	let proposed: Event | undefined = undefined;

	let acceptedProposal = pending
		&& working.events.findLast(event =>
			event.type === "settle.suggested" && event.threadId === thread?.id
			&& event.optionId === pending.optionId
			&& event.source.messageId === pending.messageId
			&& event.source.author.kind === "member"
			&& event.source.author.handle === pending.proposer
		);
	if (
		!thread || thread.status === "decided" || thread.status === "discarded"
		|| message.author.kind !== "member" || !pending || !acceptedProposal
		|| pending.proposer !== message.author.handle || option !== pending.optionId
		|| noul(candidate.answers, "withdraws_pending_settle") < 0.8
		|| /\b(?:if|unless|might|would|could)\b/i.test(candidate.quote)
		|| candidate.quote.trim().endsWith("?")
	) {
		outcome.status = "review";
		outcome.gate = "pending withdrawal needs a clear owned proposal";
		return undefined;
	}
	proposed = {
		...base(thread.id, "stance.changed"),
		type: "stance.changed",
		source: source("withdrawal"),
		optionId: pending.optionId,
		scopedProposalId: null,
		position: "neutral",
	};

	return { proposed };
}
