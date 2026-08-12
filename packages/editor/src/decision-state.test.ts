import { describe, expect, it } from "bun:test";

import { countUnanswered, visibleDecisionView } from ".";

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
		expect(visibleDecisionView("plan", false, 2)).toBe("decisions");
		expect(visibleDecisionView("plan", true, 2)).toBe("plan");
		expect(visibleDecisionView("decisions", true, 0)).toBe("decisions");
	});

	it.each(["plan", "decisions"] as const)(
		"keeps a saved %s preference out of an opening transition until prose exists",
		preference => {
			expect(visibleDecisionView(preference, false, 2)).toBe("decisions");
			expect(visibleDecisionView(preference, false, 0, true)).toBe("decisions");
			expect(visibleDecisionView(preference, true, 0, true)).toBe("plan");
			expect(visibleDecisionView(preference, true, 0)).toBe(preference);
		},
	);
});
