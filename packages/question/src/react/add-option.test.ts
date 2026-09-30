import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionView } from "./question-view";
import { AUTH } from "./question-view.test-fixtures";

// Whole original269/494/509/521 callbacks, archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
test("a multi-question card does not offer adding options", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: {
			questions: [AUTH.questions[0], {
				id: "scope",
				header: "Scope",
				question: "What belongs in the first cut?",
				multiple: true,
				options: [{ id: "anchors", label: "Anchors", description: "" }],
			}],
		},
		drafts: {},
		onAddOption: async () => ({ ok: true as const }),
	}));
	expect(markup).not.toContain("Add another option");
});

test("Add another is hidden at the option limit", () => {
	let options = Array.from({ length: 10 }, (_, index) => ({
		id: `o${index}`,
		label: `Option ${index}`,
		description: "",
	}));
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: { questions: [{ ...AUTH.questions[0], options }] },
		drafts: {},
		onAddOption: async () => ({ ok: true as const }),
	}));

	expect(markup).not.toContain("Add another option");
});

test("a temporarily locked composer trigger remains available to reopen read-only", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		disabled: true,
		onAddOption: async () => ({ ok: true as const }),
	}));

	expect(markup).toMatch(/<button[^>]*aria-label="Add another option"[^>]*>/);
	expect(markup).not.toMatch(/<button[^>]*aria-label="Add another option"[^>]*disabled=""/);
});

test("a composer trigger without an add handler is natively disabled", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		disabled: true,
		showActions: true,
	}));

	expect(markup).toMatch(/<button[^>]*aria-label="Add another option"[^>]*disabled=""/);
});
