import type { QuestionnaireEntry } from "./questionnaires";
import { cardStatus } from "@chopin/dialect";

import type { Question } from "@chopin/protocol";

export type DecisionView = "plan" | "decisions";
export type OpeningPhase = "initial" | "forced" | "complete";

export type DecisionViewState = {
	phase: OpeningPhase;
	preferred: DecisionView;
};

export function countUnanswered(
	entries: QuestionnaireEntry[],
	cardMeta?: ReadonlyMap<string, Question.CardMeta>,
): number {
	return entries.reduce(
		(total, entry) => {
			let status = cardMeta?.get(entry.id)?.status ?? cardStatus(entry.value);
			if (status === "decided" || status === "discarded") return total;
			if (status === "reopened") return total + entry.value.questions.length;
			return total
				+ entry.value.questions.filter(question => question.answer === undefined).length;
		},
		0,
	);
}

export function firstOpenDecision(
	entries: QuestionnaireEntry[],
	cardMeta?: ReadonlyMap<string, Question.CardMeta>,
): QuestionnaireEntry | undefined {
	return entries.find(entry => {
		let status = cardMeta?.get(entry.id)?.status ?? cardStatus(entry.value);
		return status === "open" || status === "reopened";
	});
}

/** A conversation-linked card is authored document content even before prose exists. */
export function documentHasPlanningContent(
	hasPlanProse: boolean,
	entries: QuestionnaireEntry[],
): boolean {
	return hasPlanProse || entries.some(entry => !!entry.value.thread);
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
