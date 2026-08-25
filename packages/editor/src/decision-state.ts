import type { QuestionnaireEntry } from "./questionnaires";

export type DecisionView = "plan" | "decisions";
export type OpeningPhase = "initial" | "forced" | "complete";

export type DecisionViewState = {
	phase: OpeningPhase;
	preferred: DecisionView;
};

export function countUnanswered(entries: QuestionnaireEntry[]): number {
	return entries.reduce(
		(total, entry) =>
			total + entry.value.questions.filter(question => question.answer === undefined).length,
		0,
	);
}

/** A forced opening yields to Plan only when prose first arrives. */
export function advanceDecisionView(
	state: DecisionViewState,
	hasPlanContent: boolean,
	unanswered: number,
): DecisionViewState {
	if (state.phase === "complete") return state;
	if (state.phase === "forced") {
		return hasPlanContent ? { phase: "complete", preferred: "plan" } : state;
	}
	if (hasPlanContent) return { ...state, phase: "complete" };
	return unanswered > 0 ? { ...state, phase: "forced" } : state;
}

export function selectDecisionView(
	state: DecisionViewState,
	preferred: DecisionView,
): DecisionViewState {
	return { ...state, phase: "complete", preferred };
}

export function visibleDecisionView(
	state: DecisionViewState,
	hasPlanContent: boolean,
	unanswered: number,
): DecisionView {
	if (state.phase === "forced") return hasPlanContent ? "plan" : "decisions";
	if (state.phase === "initial" && !hasPlanContent && unanswered > 0) return "decisions";
	return state.preferred;
}
