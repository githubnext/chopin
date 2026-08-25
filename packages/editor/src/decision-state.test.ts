import { describe, expect, it } from "bun:test";

import { advanceDecisionView, countUnanswered, selectDecisionView, visibleDecisionView } from ".";

import type { DecisionViewState } from ".";

import type { QuestionnaireEntry } from "./questionnaires";

function entry(answers: Array<string | undefined>): QuestionnaireEntry {
	return {
		id: String(answers.length),
		value: {
			id: String(answers.length),
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

describe("decision attention", () => {
	it("counts unresolved questions rather than questionnaire cards", () => {
		expect(countUnanswered([entry([undefined, undefined]), entry(["Done"])]))
			.toBe(2);
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
