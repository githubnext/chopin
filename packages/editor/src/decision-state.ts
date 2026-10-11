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
			if (status === "decided" || status === "discarded" || status === "expired") return total;
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

/**
 * Only prose makes a document more than its questions. A card, even one linked
 * to a conversation, is a question waiting for an answer, and a blank page full
 * of them belongs in Decisions.
 */
export function documentHasPlanningContent(hasPlanProse: boolean): boolean {
	return hasPlanProse;
}

/**
 * The opening phase routes a blank document to Decisions once per entry.
 *
 * Editing declines routing for good: moving someone mid-thought costs more
 * than one extra click. A forced view holds until prose exists and nothing is
 * left to answer, so a Planner heading cannot pull the reader out mid-deck.
 */
export function advanceDecisionView(
	state: DecisionViewState,
	hasPlanContent: boolean,
	unanswered: number,
	editing = false,
): DecisionViewState {
	if (state.phase === "complete") return state;
	if (state.phase === "forced") {
		return hasPlanContent && unanswered === 0 ? { phase: "complete", preferred: "plan" } : state;
	}
	if (hasPlanContent) return { ...state, phase: "complete" };
	if (unanswered === 0) return state;
	return editing ? { ...state, phase: "complete" } : { ...state, phase: "forced" };
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
	editing = false,
): DecisionView {
	if (state.phase === "forced") {
		return hasPlanContent && unanswered === 0 ? "plan" : "decisions";
	}
	if (state.phase === "initial" && !hasPlanContent && unanswered > 0 && !editing) {
		return "decisions";
	}
	return state.preferred;
}
