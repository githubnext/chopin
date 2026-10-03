import { runWithdrawal } from "./policy-candidate-withdrawal";
import { runAgreement } from "./policy-candidate-agreement";
import { runQuestion } from "./policy-candidate-question";
import { runContribution } from "./policy-candidate-contribution";
import { runStance } from "./policy-candidate-stance";
import { runResolution } from "./policy-candidate-resolution";
import { runReopening } from "./policy-candidate-reopening";
import type { CandidateEntry } from "./policy-candidate-entry";
import type { CandidateRole } from "./policy-candidate-role";
import type { PolicyContext } from "./policy-context";
import type { Event } from "./policy-types";

/** Private role routing preserves handled skips separately from a missing proposal. */
export function proposeCandidate(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
): { proposed: Event | undefined } | undefined {
	let { role } = frame;
	if (role === "withdrawal") {
		return runWithdrawal(context, entry, frame);
	} else if (role === "none") {
		return runAgreement(context, entry, frame);
	} else if (role === "question") {
		return runQuestion(context, entry, frame);
	} else if (["option", "reason", "constraint"].includes(role)) {
		return runContribution(context, entry, frame);
	} else if (role === "support" || role === "objection") {
		return runStance(context, entry, frame);
	} else if (role === "resolution") {
		return runResolution(context, entry, frame);
	} else if (role === "reopening") {
		return runReopening(context, entry, frame);
	}
	return { proposed: undefined };
}
