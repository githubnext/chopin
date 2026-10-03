import { applyInference } from "./domain";
import type { CandidateEntry } from "./policy-candidate-entry";
import { createCandidateFactories } from "./policy-candidate-factories";
import type { CandidateRole } from "./policy-candidate-role";
import type { PolicyContext } from "./policy-context";
import { immediateSpikeCondition, OWNED_QUOTE_MIN } from "./policy-cues";
import { choice, noul } from "./policy-scoring";
import type { Event } from "./policy-types";
import { activeSettleDeferral } from "./preference";
import { spikePreferenceLabel } from "./validation-fields";

/** Undefined handles/skips this candidate; continuation carries only its cached spike label. */
export function runCandidateVerification(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
) {
	let { message, first, events } = context;
	let { index, candidate, outcome } = entry;
	let { thread, role } = frame;
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	try {
		let deferred = thread && activeSettleDeferral(thread, working.events);
		let subject = deferred?.source.quote.match(
			/\b(?:verify|check|test)\s+(?:the\s+)?([\p{L}][\p{L}\p{N}-]*)/iu,
		)?.[1]?.replace(/s$/i, "");
		let verifiedSubject = subject && new RegExp(
			`^(?:the\\s+[\\p{L}\\p{N}-]+\\s+test\\s+passed\\s+and\\s+)?(?:`
				+ `(?:the\\s+)?${subject}s?\\s+(?:(?:have|has|had)\\s+been|is|are|was|were)\\s+verified`
				+ `|we\\s+(?:have\\s+)?verified\\s+(?:the\\s+)?${subject}s?)`
				+ `[.!]?$`,
			"iu",
		).test(candidate.quote.trim());
		let verificationOption = choice(candidate.answers, "chosen_option");
		let mentionedOption = choice(candidate.answers, "option");
		if (
			thread && deferred && thread.pendingSettle && message.author.kind === "member"
			&& (role === "reason" || role === "resolution")
			&& choice(first, "thread_target") === thread.id
			&& noul(first, `c${index}_owned_unretracted`) >= OWNED_QUOTE_MIN
			&& (noul(first, "evidence") >= 0.8 || noul(first, "explicit_resolution") >= 0.8)
			&& (noul(candidate.answers, "planning_substance") >= 0.8
				|| noul(candidate.answers, "explicit_resolution") >= 0.85)
			&& (verificationOption === "none"
				|| verificationOption === thread.pendingSettle.optionId)
			&& (mentionedOption === "none"
				|| mentionedOption === thread.pendingSettle.optionId)
			&& verifiedSubject
		) {
			let resumed: Event = {
				...base(thread.id, "settle.resumed"),
				type: "settle.resumed",
				proposalId: deferred.proposalId,
				deferredEventId: deferred.id,
				source: source("verification"),
			};
			try {
				working = applyInference(working, resumed, message);
				events.push(resumed);
				outcome.eventIds.push(resumed.id);
				outcome.status = "accepted";
				outcome.gate = "accepted";
			} catch {
				outcome.status = "review";
				outcome.gate = "verification needs review";
			}
			return undefined;
		}
		let spikeLabel = spikePreferenceLabel(candidate.quote);
		if (spikeLabel && immediateSpikeCondition(message.text, candidate.end)) {
			outcome.status = "review";
			outcome.gate = "spike choice has an immediate condition";
			return undefined;
		}
		return { spikeLabel };
	} finally {
		context.working = working;
	}
}
