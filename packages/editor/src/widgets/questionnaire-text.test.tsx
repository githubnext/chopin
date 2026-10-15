import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionnaireCard } from "./questionnaire";
import type { Questionnaire } from "@chopin/dialect";

let value: Questionnaire = {
	id: "onboarding",
	status: "open",
	questions: [{
		id: "approach",
		header: "Onboarding",
		prompt: "How should onboarding work?",
		response: "text",
		multiple: false,
		options: [],
	}],
};

test("native card preserves written response mode and stays disabled without a writable connection", () => {
	let html = renderToStaticMarkup(createElement(QuestionnaireCard, {
		value,
		presentation: "list",
		canEdit: false,
	}));
	expect(html).toContain(">Answer<");
	expect(html).toMatch(/<textarea[^>]*disabled=""/);
	expect(html).not.toContain(">Save<");
});

test("native decided card preserves the authored prose and attribution", () => {
	let html = renderToStaticMarkup(createElement(QuestionnaireCard, {
		value: {
			...value,
			status: "decided",
			by: "maggie",
			questions: [{
				...value.questions[0]!,
				answer: "Capture one real question.\nExplain as they go.",
			}],
		},
		presentation: "list",
	}));
	expect(html).toContain("Capture one real question.\nExplain as they go.");
	expect(html).toContain("Decided");
	expect(html).toContain("@maggie");
	expect(html).not.toContain("<textarea");
});

test("reopening a native written card shows the previous prose without confirming it again", () => {
	let html = renderToStaticMarkup(createElement(QuestionnaireCard, {
		value: {
			...value,
			status: "reopened",
			questions: [{
				...value.questions[0]!,
				previous: {
					choices: [],
					value: "A guided tour.",
					by: "maggie",
					at: "2026-10-14T22:00:00Z",
				},
			}],
		},
		presentation: "list",
	}));
	expect(html).toContain("Previously: A guided tour.");
	expect(html).toContain(">Answer<");
	expect(html).not.toContain("question-written-answer");
});
