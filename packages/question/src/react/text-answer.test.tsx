import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chooseAdded, QuestionView } from "./question-view";
import { projectSuggestion } from "./project-suggestion";
import type { Definition, Draft } from "../index";

let definition: Definition = {
	questions: [{
		id: "onboarding",
		header: "Onboarding",
		question: "How should onboarding work?",
		description: "Help people capture their first unresolved question.",
		response: "text",
		multiple: false,
		options: [],
	}],
};
let draft: Draft = {
	mode: "custom",
	choice: null,
	options: {},
	custom: "Start with a real question.",
};

test("written decisions use one answer field and the existing Save action", () => {
	let html = renderToStaticMarkup(createElement(QuestionView, {
		definition,
		drafts: { onboarding: draft },
		onChange() {},
		onSubmit() {},
		onAddOption: async () => ({ ok: true as const }),
	}));
	expect(html).toContain(">Answer<");
	expect(html).not.toContain("Shared draft");
	expect(html).toContain("Start with a real question.");
	expect(html).not.toContain("question-key");
	expect(html).not.toContain("Add an approach");
	expect(html).not.toContain("Add an option");
	expect(html).toContain(">Save<");
	expect(html).not.toContain(">Open<");
	expect(html).not.toContain('type="radio"');
	expect(html).not.toContain('type="checkbox"');
});

test("recorded prose preserves newlines and context instead of showing a selected option", () => {
	let html = renderToStaticMarkup(createElement(QuestionView, {
		definition,
		drafts: {},
		status: "answered",
		answers: [{
			question: definition.questions[0]!.question,
			custom: "Start small.\nThen explain.",
		}],
		onReopen() {},
	}));
	expect(html).toContain('class="question-written-answer"');
	expect(html).toContain("Start small.\nThen explain.");
	expect(html).toContain(definition.questions[0]!.description!);
	expect(html).toContain(">Decided<");
	expect(html).toContain(">Reopen<");
	expect(html).not.toContain("Selected:");
	expect(html).not.toContain("<textarea");
});

test("choice suggestions cannot become a written answer", () => {
	let question = definition.questions[0]!;
	expect(chooseAdded(question, draft, "guided", undefined)).toBeUndefined();
	expect(projectSuggestion(question, undefined, { optionId: "guided", revision: 1 })).toEqual({
		draft: undefined,
	});
});
