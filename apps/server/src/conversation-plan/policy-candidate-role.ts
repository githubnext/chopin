import type { CandidateEntry } from "./policy-candidate-entry";
import type { PolicyContext } from "./policy-context";
import { directOwnedCommitment, directRecommendation } from "./policy-cues";
import { choice, noul, roleChoice } from "./policy-scoring";
import { effectivePending } from "./preference";
import { hasWithdrawalCue } from "./question-shared";

/** Undefined skips this candidate; returned references keep their original pre-retarget timing. */
export function captureCandidateRole(context: PolicyContext, entry: CandidateEntry) {
	let { input, message, first } = context;
	let { index, candidate, outcome } = entry;
	let { optionGroup, sequentialChoiceQuestions } = context.candidateRun!;
	let working = context.working;
	let selectedTarget = context.selectedTarget;
	try {
		let target = choice(candidate.answers, "thread");
		let option = choice(candidate.answers, "option");
		let pendingThread = working.threads.find(item => item.id === target);
		let pending = pendingThread && effectivePending(pendingThread, working.events);
		let pendingAgreement = pending && message.author.kind === "member"
			&& message.author.handle !== pending.proposer
			&& (!option || option === "none" || option === pending.optionId)
			&& noul(candidate.answers, "agrees_with_settle") >= 0.7;
		let role = roleChoice(candidate.answers, first, Boolean(pendingAgreement));
		let roleAnswer = candidate.answers.role;
		let targetThread = working.threads.find((item) => item.id === target);
		let chosenOption = choice(candidate.answers, "chosen_option");
		let linkedCard = targetThread && input.linkedCards?.get(targetThread.id);
		let knownChosenOption = !!targetThread && !!chosenOption
			&& (targetThread.contributions.some(item =>
				item.kind === "option" && item.id === chosenOption
			) || !!linkedCard && linkedCard.cardId === targetThread.questionnaireId
					&& linkedCard.options.some(item => item.id === chosenOption));
		let reasonProbability = roleAnswer?.type === "choice"
			? roleAnswer.probabilities.reason ?? 0
			: 0;
		let supportProbability = roleAnswer?.type === "choice"
			? roleAnswer.probabilities.support ?? 0
			: 0;
		if (
			!role && roleAnswer?.type === "choice"
			&& ["reason", "support"].includes(roleAnswer.choice)
			&& reasonProbability >= 0.35 && supportProbability >= 0.3
			&& reasonProbability + supportProbability >= 0.8
			&& Math.abs(reasonProbability - supportProbability) <= 0.12
			&& targetThread && !["decided", "discarded"].includes(targetThread.status)
			&& choice(first, "thread_target") === targetThread.id
			&& option && targetThread.contributions.some(item =>
				item.kind === "option" && item.id === option
			)
			&& ["supports", "challenges", "qualifies"].includes(
				choice(candidate.answers, "relation") ?? "",
			)
			&& noul(first, "reason") >= 0.8
			&& first.significance?.type === "score" && first.significance.score >= 1
			&& noul(candidate.answers, "planning_substance") >= 0.8
			&& noul(candidate.answers, "duplicate") < 0.3
			&& /\b(?:because|since|reduces?|avoids?|saves?|improves?|allows?|enables?|so that|so we can|lets? us)\b/i
				.test(candidate.quote)
		) role = "reason";
		let relationAnswer = candidate.answers.relation;
		let qualifiedPending = pending && targetThread
			&& targetThread.status !== "decided" && targetThread.status !== "discarded"
			&& targetThread.contributions.some(item =>
				item.kind === "option" && item.id === pending.optionId
			)
			&& relationAnswer?.type === "choice" && relationAnswer.choice === "qualifies"
			&& (relationAnswer.probabilities.qualifies ?? 0) >= 0.7
			&& (relationAnswer.probabilities.qualifies ?? 0)
						- Math.max(
							0,
							...Object.entries(relationAnswer.probabilities)
								.filter(([key]) => key !== "qualifies").map(([, value]) => value),
						) >= 0.2
			&& noul(candidate.answers, "qualifies_pending_settle") >= 0.8
			&& noul(candidate.answers, "planning_substance") >= 0.8
			&& noul(candidate.answers, "duplicate") < 0.3
			&& first.significance?.type === "score" && first.significance.score >= 1;
		if (
			qualifiedPending && (!role || ["option", "reason", "constraint", "support"].includes(role))
		) {
			role = "constraint";
		}
		let strongRecommendation = message.author.kind === "member"
			&& directRecommendation(candidate.quote)
			&& choice(first, "act") === "proposal"
			&& noul(candidate.answers, "support") >= 0.8
			&& !!targetThread && !["decided", "discarded"].includes(targetThread.status)
			&& (!option || option === "none" || option === chosenOption)
			&& knownChosenOption;
		let resolutionProbability = roleAnswer?.type === "choice"
			? roleAnswer.probabilities.resolution ?? 0
			: 0;
		let optionProbability = roleAnswer?.type === "choice"
			? roleAnswer.probabilities.option ?? 0
			: 0;
		if (
			!role && message.author.kind === "member" && targetThread
			&& !["decided", "discarded"].includes(targetThread.status)
			&& directOwnedCommitment(candidate.quote)
			&& choice(first, "act") === "commitment"
			&& resolutionProbability >= 0.7
			&& knownChosenOption
		) role = "resolution";
		// A proposed new choice can sound like a resolution; show it without settling it.
		if (
			!role && targetThread && !["decided", "discarded"].includes(targetThread.status)
			&& choice(candidate.answers, "chosen_option") === "new"
			&& resolutionProbability >= 0.3 && optionProbability >= 0.3
			&& resolutionProbability + optionProbability >= 0.85
			&& Math.abs(resolutionProbability - optionProbability) <= 0.15
			&& noul(first, "new_option") >= 0.8
			&& noul(candidate.answers, "new_option") >= 0.85
			&& noul(candidate.answers, "planning_substance") >= 0.7
			&& noul(candidate.answers, "duplicate") < 0.8
			&& first.significance?.type === "score" && first.significance.score >= 2
		) role = "option";
		if (strongRecommendation && (!role || role === "option" || role === "support")) {
			role = "resolution";
		}
		let directNewChoice = message.author.kind === "member" && !!targetThread
			&& !["decided", "discarded"].includes(targetThread.status)
			&& chosenOption === "new" && option === "new"
			&& (!role || ["option", "support", "resolution"].includes(role))
			&& candidate.quote.length <= 500 && !candidate.quote.trim().endsWith("?")
			&& !/\b(?:not|don't|do not|without|if|unless)\b/i.test(candidate.quote)
			&& noul(first, "new_option") >= 0.8
			&& noul(candidate.answers, "new_option") >= 0.85
			&& noul(candidate.answers, "planning_substance") >= 0.7
			&& noul(candidate.answers, "duplicate") < 0.3
			&& !targetThread.contributions.some(item =>
				item.kind === "option"
				&& item.text.trim().replace(/\s+/g, " ").toLowerCase()
					=== candidate.quote.trim().replace(/\s+/g, " ").toLowerCase()
			)
			&& (directRecommendation(candidate.quote)
					&& choice(first, "act") === "proposal"
					&& noul(candidate.answers, "support") >= 0.8
				|| directOwnedCommitment(candidate.quote)
					&& choice(first, "act") === "commitment"
					&& noul(first, "explicit_resolution") >= 0.8
					&& noul(candidate.answers, "explicit_resolution") >= 0.8);
		if (directNewChoice) role = "resolution";
		if (hasWithdrawalCue(candidate.quote)) {
			if (noul(first, "withdrawal") < 0.8) {
				outcome.status = "review";
				outcome.gate = "pending withdrawal needs a clear owned proposal";
				return undefined;
			}
			role = "withdrawal";
		}
		if (optionGroup) target = optionGroup;
		if (optionGroup && sequentialChoiceQuestions && index === 0 && role === "question") {
			role = "option";
		}
		if (!role) return undefined;
		if (
			message.author.kind === "agent"
			&& ["support", "objection", "withdrawal", "resolution", "reopening"].includes(role)
		) {
			outcome.gate = "Planner cannot cast a human stance or decision";
			return undefined;
		}
		if (role !== "none" && target && !["new", "none"].includes(target)) {
			selectedTarget = target;
			outcome.targetId = target;
		}
		let thread = working.threads.find((item) => item.id === target);
		if (thread?.status === "discarded" && role !== "question") {
			outcome.gate = "thread discarded";
			return undefined;
		}
		return {
			target,
			option,
			pending,
			role,
			targetThread,
			chosenOption,
			linkedCard,
			qualifiedPending,
			strongRecommendation,
			directNewChoice,
			thread,
		};
	} finally {
		context.selectedTarget = selectedTarget;
	}
}

export type CandidateRole = NonNullable<ReturnType<typeof captureCandidateRole>>;
