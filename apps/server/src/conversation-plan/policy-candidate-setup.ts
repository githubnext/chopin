import type { CandidateRun, PolicyContext } from "./policy-context";
import {
	COMMA_ALTERNATIVES,
	directOwnedCommitment,
	directRecommendation,
	OWNED_QUOTE_MIN,
} from "./policy-cues";
import { stableId } from "./policy-identity";
import { choice, noul, roleChoice } from "./policy-scoring";
import { MAX_QUOTE_CANDIDATES } from "./quote-budget";

/** Prepare once after both terminal runners continue; later candidates share this mutable run. */
export function prepareCandidateRun(context: PolicyContext): CandidateRun {
	let { input, channelId, message, first } = context;
	let { optionLabels } = context.facts!;
	let seenOptionLabels = new Set<string>();
	let sequentialChoiceQuestions = input.candidates.length === 3
		&& input.candidates[0]?.start === 0
		&& input.candidates[2]?.end === message.text.length
		&& /^Should we\b[^?]{1,160}\?$/i.test(input.candidates[0]?.quote ?? "")
		&& input.candidates.slice(1).every((candidate, index) =>
			/^Or\b[^?]{1,160}\?$/i.test(candidate.quote)
			&& /^\s+$/.test(message.text.slice(input.candidates[index]!.end, candidate.start))
		);
	let optionGroup = input.state.threads.length === 0 && message.text.length <= 500
			&& noul(first, "new_question") >= 0.9
			&& choice(first, "act") === "question" && choice(first, "thread_target") === "new"
			&& input.candidates.length >= 2 && input.candidates.length <= MAX_QUOTE_CANDIDATES
			&& new Set(optionLabels).size >= 2
			&& input.candidates.every((candidate, index) =>
				noul(first, `c${index}_owned_unretracted`) >= OWNED_QUOTE_MIN
				&& Number.isSafeInteger(candidate.start) && candidate.start >= 0
				&& Number.isSafeInteger(candidate.end) && candidate.end <= message.text.length
				&& candidate.end > candidate.start
				&& candidate.quote.length <= 500 && !!candidate.quote.trim()
				&& message.text.slice(candidate.start, candidate.end) === candidate.quote
				&& (roleChoice(candidate.answers, first) === "option"
					|| sequentialChoiceQuestions && index === 0
						&& roleChoice(candidate.answers, first) === "question")
				&& !COMMA_ALTERNATIVES.test(candidate.quote.trim())
				&& noul(candidate.answers, "new_option") >= 0.75
				&& candidate.answers.thread?.type === "choice"
				&& ["new", "none"].includes(candidate.answers.thread.choice)
			)
		? `thread:${stableId(channelId, message.id, 0, "thread").slice(11)}`
		: undefined;
	let choicesByThread = new Map<string, Set<string>>();
	for (let [index, candidate] of input.candidates.entries()) {
		let target = choice(candidate.answers, "thread");
		let chosen = choice(candidate.answers, "chosen_option");
		let namedOption = choice(candidate.answers, "option");
		let thread = input.state.threads.find(item => item.id === target);
		if (
			message.author.kind !== "member" || !thread
			|| ["decided", "discarded"].includes(thread.status)
			|| noul(first, `c${index}_owned_unretracted`) < OWNED_QUOTE_MIN
			|| message.text.slice(candidate.start, candidate.end) !== candidate.quote
		) continue;
		let known = chosen
			&& thread.contributions.some(item => item.kind === "option" && item.id === chosen);
		let card = input.linkedCards?.get(thread.id);
		let linkedOption = card && card.cardId === thread.questionnaireId
			&& card.options.some(item => item.id === chosen);
		let novel = chosen === "new" && namedOption === "new"
			&& noul(first, "new_option") >= 0.8
			&& noul(candidate.answers, "new_option") >= 0.85
			&& noul(candidate.answers, "planning_substance") >= 0.7
			&& noul(candidate.answers, "duplicate") < 0.3;
		if (!known && !linkedOption && !novel) continue;
		let recommendation = directRecommendation(candidate.quote)
			&& choice(first, "act") === "proposal"
			&& noul(candidate.answers, "support") >= 0.8;
		let commitment = directOwnedCommitment(candidate.quote)
			&& (known || linkedOption
				? choice(first, "act") === "commitment"
					|| noul(first, "explicit_resolution") >= 0.8
						&& noul(candidate.answers, "explicit_resolution") >= 0.85
				: choice(first, "act") === "commitment"
					&& noul(first, "explicit_resolution") >= 0.8
					&& noul(candidate.answers, "explicit_resolution") >= 0.8);
		if (!recommendation && !commitment) continue;
		let choices = choicesByThread.get(thread.id) ?? new Set<string>();
		choices.add(
			known || linkedOption
				? chosen!
				: `new:${candidate.quote.trim().replace(/\s+/g, " ").toLowerCase()}`,
		);
		choicesByThread.set(thread.id, choices);
	}
	let competingMessageTargets = new Set(
		[...choicesByThread].filter(([, choices]) => choices.size > 1).map(([id]) => id),
	);
	let run = { seenOptionLabels, sequentialChoiceQuestions, optionGroup, competingMessageTargets };
	context.candidateRun = run;
	return run;
}
