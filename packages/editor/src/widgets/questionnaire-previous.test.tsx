import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionnaireCard } from "./questionnaire";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";

// Whole original259 callback, archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
test("a reopened legacy answer keeps its read-only previous text", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: false,
		connected: true,
		meta: { ...META, status: "reopened" },
		value: {
			...DECIDED,
			questions: [{
				...DECIDED.questions[0]!,
				answer: undefined,
				choices: undefined,
				previous: {
					choices: [],
					value: "Use the existing GitHub app",
					by: "ana",
					at: "2026-09-25T10:00:00.000Z",
				},
			}],
		},
	}));
	expect(markup).toContain("Previously: Use the existing GitHub app · @ana");
});
