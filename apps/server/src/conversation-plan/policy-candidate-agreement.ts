import type { CandidateEntry } from "./policy-candidate-entry";
import { createCandidateFactories } from "./policy-candidate-factories";
import type { CandidateRole } from "./policy-candidate-role";
import type { PolicyContext } from "./policy-context";
import type { Event } from "./policy-types";
import { noul } from "./policy-scoring";
import { effectivePending } from "./preference";

/** Invoke only for its matching captured role; undefined skips, a result continues without application. */
export function runAgreement(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
): { proposed: Event | undefined } | undefined {
	let { message } = context;
	let { candidate, outcome } = entry;
	let { thread } = frame;
	let selectedTarget = context.selectedTarget;
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	let proposed: Event | undefined = undefined;
	try {
		let pending = thread && effectivePending(thread, working.events);
		let namedOption = candidate.answers.option?.type === "choice"
			? candidate.answers.option.choice
			: undefined;
		if (
			thread && pending && message.author.kind === "member"
			&& message.author.handle !== pending.proposer
			&& (!namedOption || namedOption === "none" || namedOption === pending.optionId)
			&& noul(candidate.answers, "agrees_with_settle") >= 0.7
		) {
			proposed = {
				...base(thread.id, "settle.agreed"),
				type: "settle.agreed",
				source: source("support"),
				optionId: pending.optionId,
			};
			selectedTarget = thread.id;
			outcome.targetId = thread.id;
		}

		return { proposed };
	} finally {
		context.selectedTarget = selectedTarget;
	}
}
