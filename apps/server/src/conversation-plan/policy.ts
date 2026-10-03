import { applyCandidateEvent } from "./policy-candidate-application";
import { beginCandidate } from "./policy-candidate-entry";
import { runDirectNewChoice } from "./policy-candidate-new-choice";
import { captureCandidateRole } from "./policy-candidate-role";
import { runScopedAssent, runScopedProposal } from "./policy-candidate-scoped";
import { prepareCandidateRun } from "./policy-candidate-setup";
import { runCandidateVerification } from "./policy-candidate-verification";
import { createPolicyContext } from "./policy-context";
import { finishPolicy } from "./policy-final";
import { runInitialTerminals } from "./policy-initial-terminals";
import { proposeCandidate } from "./policy-proposal";
import { runRemainingTerminals } from "./policy-remaining-terminals";
import { explicitListQuotes } from "./quotes";
import type { PolicyInput, PolicyResult } from "./policy-types";

export { optionIdFor } from "./policy-identity";
export type { PolicyInput, PolicyResult } from "./policy-types";

export function planEvents(input: PolicyInput): PolicyResult {
	let context = createPolicyContext(input);
	let terminal = runInitialTerminals(context);
	if (terminal) return terminal;
	terminal = runRemainingTerminals(context);
	if (terminal) return terminal;
	prepareCandidateRun(context);
	let { events } = context;
	for (let [index, candidate] of input.candidates.entries()) {
		let entry = beginCandidate(context, index, candidate);
		if (!entry) continue;
		let frame = captureCandidateRole(context, entry);
		if (!frame) continue;
		let spike = runCandidateVerification(context, entry, frame);
		if (!spike) continue;
		if (!runScopedAssent(context, entry, frame)) continue;
		if (!runScopedProposal(context, entry, frame, spike)) continue;
		if (!runDirectNewChoice(context, entry, frame)) continue;
		let proposal = proposeCandidate(context, entry, frame);
		if (!proposal) continue;
		let { proposed } = proposal;
		if (!proposed) continue;
		applyCandidateEvent(context, entry, frame, proposed);
		if (events.length >= 12) break;
	}
	let result = finishPolicy(context);
	let listed = explicitListQuotes(input.message.text);
	let bareList = listed.length >= 3
		&& input.message.text.indexOf("?") < 0
		&& listed.length === input.candidates.length
		&& listed.every((quote, index) =>
			quote.quote === input.candidates[index]?.quote
			&& quote.start === input.candidates[index]?.start
			&& quote.end === input.candidates[index]?.end
		);
	if (
		bareList && !(
			result.events.length === listed.length
			&& result.outcomes.length === listed.length
			&& result.outcomes.every(outcome => outcome.status === "accepted")
			&& result.events.every((event, index) =>
				event.type === "option.added"
				&& event.source?.start === listed[index]!.start
				&& event.source.end === listed[index]!.end
			)
		)
	) {
		return {
			events: [],
			candidates: result.candidates,
			outcomes: listed.map(quote => ({
				start: quote.start,
				end: quote.end,
				status: "review",
				gate: "alternative list could not be applied together",
				eventIds: [],
			})),
			policyGate: "alternative list could not be applied together",
		};
	}
	return result;
}
