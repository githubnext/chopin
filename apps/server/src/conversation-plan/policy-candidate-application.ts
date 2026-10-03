import { applyInference } from "./domain";
import type { CandidateEntry } from "./policy-candidate-entry";
import { createCandidateFactories } from "./policy-candidate-factories";
import type { CandidateRole } from "./policy-candidate-role";
import type { PolicyContext } from "./policy-context";
import { noul } from "./policy-scoring";
import type { Event } from "./policy-types";
import { activeSettleDeferral, effectivePending } from "./preference";

/** Invoke after the original no-proposal guard; the driver retains its own event cap. */
export function applyCandidateEvent(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
	proposed: Event,
): void {
	let { message, events } = context;
	let { candidate, outcome } = entry;
	let { option } = frame;
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	try {
		try {
			working = applyInference(working, proposed, message);
			events.push(proposed);
			outcome.eventIds.push(proposed.id);
			outcome.status = proposed.type === "candidate.proposed" ? "review" : "accepted";
			if (outcome.gate === "no useful role") outcome.gate = outcome.status;
			let participant = message.author.kind === "member" ? message.author.handle : undefined;
			if (
				proposed.type === "constraint.added" && participant
				&& /\b(?:verify|check|test)\b.*\bbefore\b.*\b(?:choos|decid|sav|settl)/i
					.test(candidate.quote)
				&& events.some(item =>
					item.type === "stance.changed" && item.threadId === proposed.threadId
					&& item.source.messageId === message.id && item.position === "neutral"
					&& item.source.author.kind === "member"
					&& item.source.author.handle === participant
				)
			) {
				let proposer = participant;
				let current = working.threads.find(item => item.id === proposed.threadId);
				let pending = current?.pendingSettle;
				let proposal = pending
					&& working.events.findLast(item =>
						item.type === "settle.suggested" && item.threadId === proposed.threadId
						&& item.optionId === pending.optionId
						&& item.source.messageId === pending.messageId
					);
				if (
					current && pending && proposal?.type === "settle.suggested"
					&& pending.proposer === proposer
					&& !activeSettleDeferral(current, working.events)
				) {
					let deferred: Event = {
						...base(current.id, "settle.deferred"),
						type: "settle.deferred",
						proposalId: proposal.id,
						source: source("constraint"),
					};
					working = applyInference(working, deferred, message);
					events.push(deferred);
					outcome.eventIds.push(deferred.id);
				}
			}
			if (
				proposed.type === "stance.changed" && proposed.position === "support"
				&& events.length < 12
			) {
				let current = working.threads.find((item) => item.id === proposed.threadId);
				let supporters = proposed.optionId && new Set(
					current?.stances.filter((item) =>
						item.optionId === proposed.optionId && item.position === "support"
					).map((item) => item.participant),
				);
				if (current?.status === "exploring" && supporters && supporters.size >= 2) {
					let leaning: Event = {
						...base(current.id, "thread.leaning"),
						type: "thread.leaning",
						source: proposed.source,
						optionId: proposed.optionId,
					};
					working = applyInference(working, leaning, message);
					events.push(leaning);
					outcome.eventIds.push(leaning.id);
				}
				let pending = current && effectivePending(current, working.events);
				let namedOption = candidate.answers.option?.type === "choice"
					? candidate.answers.option.choice
					: undefined;
				if (
					current && pending && message.author.kind === "member"
					&& message.author.handle !== pending.proposer
					&& (!namedOption || namedOption === "none" || namedOption === pending.optionId)
					&& (proposed.optionId === pending.optionId
						|| option === pending.optionId
							&& /^(?:yes|yep|agreed|i agree)[,!.]?$/iu.test(candidate.quote.trim())
						|| noul(candidate.answers, "agrees_with_settle") >= 0.7)
					&& events.length < 12
				) {
					let agreed: Event = {
						...base(current.id, "settle.agreed"),
						type: "settle.agreed",
						source: proposed.source,
						optionId: pending.optionId,
					};
					working = applyInference(working, agreed, message);
					events.push(agreed);
					outcome.eventIds.push(agreed.id);
				}
			}
		} catch {
			outcome.status = "review";
			outcome.gate = "domain rejected proposed event";
		}
	} finally {
		context.working = working;
	}
}
