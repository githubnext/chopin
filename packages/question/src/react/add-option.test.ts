import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionView } from "./question-view";
import { AUTH } from "./question-view.test-fixtures";

// Original multi-card, limit, permission and lock inputs, adapted to main shared options.
test("a multi-question card offers shared options for its active question", () => {
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
	expect(markup).toContain("Add an option");
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

	expect(markup).not.toContain("Add an option");
});

test("a temporarily locked composer trigger remains visible and disabled", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		disabled: true,
		onAddOption: async () => ({ ok: true as const }),
	}));

	expect(markup).toMatch(
		/<button[^>]*class="[^"]*question-add"[^>]*>[\s\S]*?Add an option<\/span><\/button>/,
	);
	expect(markup).toMatch(/<button[^>]*class="[^"]*question-add"[^>]*disabled=""/);
});

test("a composer trigger without an add handler is natively disabled", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		disabled: true,
		showActions: true,
	}));

	expect(markup).toMatch(/<button[^>]*class="[^"]*question-add"[^>]*disabled=""/);
});
