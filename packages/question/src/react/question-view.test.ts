import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { currentQuestion, QuestionView } from "./question-view";

test("a replacement definition falls back before rendering when its active question disappears", () => {
	let storage = {
		id: "storage",
		header: "Storage",
		question: "Where should room state live?",
		multiple: false,
		options: [],
	};
	let scope = {
		id: "scope",
		header: "Scope",
		question: "What belongs in the first cut?",
		multiple: false,
		options: [],
	};

	expect(currentQuestion({ questions: [storage, scope] }, "removed")).toBe(storage);
});

test("a host renderer receives only the active question panel", () => {
	let definition = {
		questions: [
			{
				id: "storage",
				header: "Storage",
				question: "Where should room state live?",
				multiple: false,
				options: [],
			},
			{
				id: "scope",
				header: "Scope",
				question: "What belongs in the first cut?",
				multiple: false,
				options: [],
			},
		],
	};
	let steps: string[] = [];

	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition,
		drafts: {},
		renderStep: ({ children, question }) => {
			steps.push(question);
			return children;
		},
	}));

	expect(steps).toEqual(["storage"]);
	expect(markup).not.toContain("content-swap-stack");
});

test("a host can present an error as motion feedback", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: {
			questions: [{
				id: "storage",
				header: "Storage",
				question: "Where should room state live?",
				multiple: false,
				options: [],
			}],
		},
		drafts: {},
		error: "Could not save the answer.",
		errorClassName: "host-error-feedback",
	}));

	expect(markup).toContain("host-error-feedback");
	expect(markup).toContain('role="alert"');
	expect(markup).toContain('data-motion-feedback="alert"');
});
