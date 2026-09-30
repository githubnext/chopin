import { describe, expect, it } from "bun:test";

import {
	advanceDecisionView,
	countUnanswered,
	documentHasPlanningContent,
	selectDecisionView,
	visibleDecisionView,
} from ".";

import type { DecisionViewState } from ".";
import type { Question } from "@chopin/protocol";

import type { QuestionnaireEntry } from "./questionnaires";

function entry(
	answers: Array<string | undefined>,
	status?: Question.CardMeta["status"],
): QuestionnaireEntry {
	return {
		id: String(answers.length),
		value: {
			id: String(answers.length),
			...(status ? { status } : {}),
			questions: answers.map((answer, index) => ({
				id: `q${index}`,
				header: `Question ${index + 1}`,
				prompt: `Question ${index + 1}?`,
				multiple: false,
				options: [],
				...(answer === undefined ? {} : { answer }),
			})),
		},
	};
}

function meta(status: Question.CardMeta["status"]): Question.CardMeta {
	return {
		status,
		origin: "planner",
		involved: [],
		history: [],
		optionOrigins: {},
		hasProse: false,
		refining: false,
		proseOrphaned: false,
	};
}

describe("decision attention", () => {
	it("counts unresolved questions rather than questionnaire cards", () => {
		expect(countUnanswered([entry([undefined, undefined]), entry(["Done"])]))
			.toBe(2);
	});

	it("excludes metadata-settled cards while preserving legacy multi-question counts", () => {
		let waiting = { ...entry([undefined, undefined]), id: "waiting" };
		let decided = { ...entry([undefined]), id: "decided" };
		let discarded = { ...entry([undefined]), id: "discarded" };
		let metadata = new Map([
			["decided", meta("decided")],
			["discarded", meta("discarded")],
		]);

		expect(countUnanswered([waiting, decided, discarded], metadata)).toBe(2);
	});

	it("counts every question when metadata reopens a card before its old projection updates", () => {
		let reopened = {
			...entry(["Earlier choice", "Earlier answer"]),
			id: "reopened",
		};
		expect(countUnanswered(
			[reopened],
			new Map([[
				"reopened",
				meta("reopened"),
			]]),
		)).toBe(2);
	});

	it("preserves unanswered question counts for partially answered open cards", () => {
		let open = { ...entry(["Earlier choice", undefined]), id: "open" };
		expect(countUnanswered(
			[open],
			new Map([[
				"open",
				meta("open"),
			]]),
		)).toBe(1);
	});

	it("uses persisted card status when metadata is unavailable", () => {
		expect(countUnanswered([
			entry([undefined, undefined], "open"),
			entry([undefined], "discarded"),
		])).toBe(2);
	});

	it("forces only a questionnaire-only opening document into Decisions", () => {
		expect(visibleDecisionView({ phase: "initial", preferred: "plan" }, false, 2)).toBe(
			"decisions",
		);
		expect(visibleDecisionView({ phase: "initial", preferred: "plan" }, true, 2)).toBe("plan");
		expect(visibleDecisionView({ phase: "initial", preferred: "decisions" }, true, 0)).toBe(
			"decisions",
		);
	});

	it("keeps a chat-linked inline card in Document while Planner questions still open Decisions", () => {
		let plannerQuestion = entry([undefined]);
		let conversationQuestion = entry([undefined]);
		conversationQuestion.value = { ...conversationQuestion.value, thread: "thread-1" };
		let initial: DecisionViewState = { phase: "initial", preferred: "plan" };
		let plannerHasContent = documentHasPlanningContent(false, [plannerQuestion]);
		let conversationHasContent = documentHasPlanningContent(false, [conversationQuestion]);

		expect(visibleDecisionView(
			initial,
			plannerHasContent,
			countUnanswered([plannerQuestion]),
		)).toBe("decisions");
		expect(visibleDecisionView(
			initial,
			conversationHasContent,
			countUnanswered([conversationQuestion]),
		)).toBe("plan");

		let state = advanceDecisionView(
			initial,
			plannerHasContent,
			countUnanswered([plannerQuestion]),
		);
		expect(state.phase).toBe("forced");
		state = advanceDecisionView(
			state,
			conversationHasContent,
			countUnanswered([plannerQuestion, conversationQuestion]),
		);
		expect(state).toEqual({ phase: "complete", preferred: "plan" });
	});

	it.each(["plan", "decisions"] as const)(
		"keeps a saved %s preference out of an opening transition until prose exists",
		preference => {
			let state: DecisionViewState = { phase: "initial", preferred: preference };
			state = advanceDecisionView(state, false, 2);
			expect(visibleDecisionView(state, false, 2)).toBe("decisions");
			state = advanceDecisionView(state, false, 0);
			expect(visibleDecisionView(state, false, 0)).toBe("decisions");
			state = advanceDecisionView(state, true, 0);
			expect(state).toEqual({ phase: "complete", preferred: "plan" });
			expect(visibleDecisionView(state, true, 0)).toBe("plan");
			expect(visibleDecisionView({ ...state, preferred: preference }, true, 0)).toBe(preference);
		},
	);

	it.each(["plan", "decisions"] as const)(
		"does not re-enter forced Decisions after opening prose is removed with a saved %s preference",
		preference => {
			let state: DecisionViewState = { phase: "initial", preferred: preference };
			state = advanceDecisionView(state, false, 2);
			state = advanceDecisionView(state, false, 0);
			state = advanceDecisionView(state, true, 0);
			state = advanceDecisionView(state, false, 1);
			expect(state).toEqual({ phase: "complete", preferred: "plan" });
			expect(visibleDecisionView(state, false, 1)).toBe("plan");
			expect(visibleDecisionView({ ...state, preferred: preference }, false, 1)).toBe(preference);
		},
	);

	it("lets explicit Document navigation override a forced Decisions opening", () => {
		let state = advanceDecisionView(
			{ phase: "initial", preferred: "plan" },
			false,
			2,
		);

		state = selectDecisionView(state, "plan");

		expect(state).toEqual({ phase: "complete", preferred: "plan" });
		expect(visibleDecisionView(state, false, 2)).toBe("plan");
	});
});
