import type { CandidateEntry } from "./policy-candidate-entry";
import { createCandidateFactories } from "./policy-candidate-factories";
import type { CandidateRole } from "./policy-candidate-role";
import type { PolicyContext } from "./policy-context";
import type { Event } from "./policy-types";
import { noul } from "./policy-scoring";
import { stableId } from "./policy-identity";

/** Invoke only for its matching captured role; undefined skips, a result continues without application. */
export function runQuestion(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
): { proposed: Event | undefined } | undefined {
	let { channelId, message, first, directQuestion } = context;
	let { index, candidate, outcome } = entry;
	let { thread, target } = frame;
	let { optionGroup } = context.candidateRun!;
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	let proposed: Event | undefined = undefined;

	if (directQuestion && !optionGroup) return undefined;
	let raisesDiscarded = thread?.status === "discarded";
	if (
		raisesDiscarded
		&& (noul(first, "new_question") < 0.9
			|| noul(candidate.answers, "raises_again") < 0.7)
	) {
		outcome.gate = "discarded question not raised again";
		return undefined;
	}
	if ((target === "new" && noul(first, "new_question") >= 0.6) || raisesDiscarded) {
		let threadId = `thread:${stableId(channelId, message.id, index, "thread").slice(11)}`;
		outcome.targetId = threadId;
		proposed = {
			...base(threadId, "thread.opened"),
			type: "thread.opened",
			source: source("question"),
			question: candidate.quote,
		};
	} else {
		outcome.status = "review";
		outcome.gate = "question target needs review";
	}

	return { proposed };
}
