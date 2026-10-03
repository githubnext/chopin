import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionView } from "./question-view";
import { AUTH } from "./question-view.test-fixtures";

// Whole original452 callback, archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
test("a stored multi-question card offers Discard through its stepper", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: {
			questions: [AUTH.questions[0], {
				id: "timing",
				header: "Timing",
				question: "When should we deploy?",
				multiple: false,
				options: [{ id: "now", label: "Now", description: "" }],
			}],
		},
		drafts: {},
		onDiscard: () => {},
	}));

	expect(markup).toContain(">Discard<");
	expect(markup).not.toContain(">Cancel<");
});
