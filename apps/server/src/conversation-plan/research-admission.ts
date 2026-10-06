import type { ConversationPlan } from "@chopin/protocol";
import type { JevAnswer } from "./jev";
import { noul } from "./policy-scoring";

export const RESEARCH_POLICY_VERSION = "research-admission-2";

const LABELS: Record<ConversationPlan.ResearchAdmission["checks"][number]["signal"], string> = {
	research_warranted: "Research need",
	external: "External suitability",
	owned: "Source ownership",
	subject_clarity: "Subject clarity",
	already_answered: "Already-answered evidence",
};

/** Intent changes the offer's suitability floor, not its evidence or ownership requirements. */
export function researchAdmission(
	answers: Record<string, JevAnswer>,
	updating: boolean,
): { admission: ConversationPlan.ResearchAdmission; failure?: string } {
	let explicit = noul(answers, "explicit_proposal") >= 0.9;
	let subject = answers.research_subject;
	let clarity = subject?.type === "choice"
		? Math.min(1, (subject.probabilities.explicit ?? 0) + (subject.probabilities.contextual ?? 0))
		: 0;
	let checks: ConversationPlan.ResearchAdmission["checks"] = [];
	if (!updating) {
		checks.push({
			signal: "research_warranted",
			score: noul(answers, "research_warranted"),
			threshold: 0.8,
			comparison: "minimum",
		});
	}
	checks.push(
		{
			signal: "external",
			score: noul(answers, "external"),
			threshold: explicit ? 0.7 : 0.8,
			comparison: "minimum",
		},
		{ signal: "owned", score: noul(answers, "owned"), threshold: 0.8, comparison: "minimum" },
		{ signal: "subject_clarity", score: clarity, threshold: 0.8, comparison: "minimum" },
		{
			signal: "already_answered",
			score: noul(answers, "already_answered"),
			threshold: 0.2,
			comparison: "maximum",
		},
	);
	let admission: ConversationPlan.ResearchAdmission = {
		path: updating
			? "existing-offer-update"
			: explicit
			? "explicit-proposal"
			: "inferred-opportunity",
		checks,
	};
	let failed = checks.find(check =>
		check.comparison === "minimum" ? check.score < check.threshold : check.score > check.threshold
	);
	if (!failed) return { admission };
	let score = Number((failed.score * 100).toFixed(2));
	let threshold = Number((failed.threshold * 100).toFixed(2));
	return {
		admission,
		failure: failed.comparison === "minimum"
			? `${LABELS[failed.signal]} below threshold: ${score}%; required ${threshold}%.`
			: `${LABELS[failed.signal]} above threshold: ${score}%; maximum ${threshold}%.`,
	};
}
