import type { QuestionnaireEntry } from "./questionnaires";

export type DecisionView = "plan" | "decisions";

export function countUnanswered(entries: QuestionnaireEntry[]): number {
	return entries.reduce(
		(total, entry) =>
			total + entry.value.questions.filter(question => question.answer === undefined).length,
		0,
	);
}

export function visibleDecisionView(
	preferred: DecisionView,
	hasPlanContent: boolean,
	unanswered: number,
	enteredForcedOpening = false,
): DecisionView {
	if (enteredForcedOpening) return hasPlanContent ? "plan" : "decisions";
	return !hasPlanContent && unanswered > 0 ? "decisions" : preferred;
}
