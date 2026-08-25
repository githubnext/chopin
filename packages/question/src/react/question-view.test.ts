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

test("a host renderer receives every stable question id with one active step", () => {
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
	let steps: { active: boolean; question: string }[] = [];

	renderToStaticMarkup(createElement(QuestionView, {
		definition,
		drafts: {},
		renderStep: ({ active, children, question }) => {
			steps.push({ active, question });
			return children;
		},
	}));

	expect(steps).toEqual([
		{ active: true, question: "storage" },
		{ active: false, question: "scope" },
	]);
});
