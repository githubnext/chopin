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
		options: [{ id: "guided", label: "A guided first decision", description: "" }],
	}],
};
let draft: Draft = {
	mode: "custom",
	choice: null,
	options: {},
	custom: "Start with a real question.",
};

test("written decisions keep approaches separate from the explicit human record action", () => {
	let html = renderToStaticMarkup(createElement(QuestionView, {
		definition,
		drafts: { onboarding: draft },
		onChange() {},
		onSubmit() {},
		onAddOption: async () => ({ ok: true as const }),
	}));
	expect(html).toContain("Working answer");
	expect(html).toContain("Shared draft until someone records it");
	expect(html).toContain("Start with a real question.");
	expect(html).toContain("A guided first decision");
	expect(html).toContain("Add an approach");
	expect(html).toContain(">Record decision<");
	expect(html).toContain(">Open<");
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

test("adding a candidate or receiving a choice suggestion cannot become a text answer", () => {
	let question = definition.questions[0]!;
	expect(chooseAdded(question, draft, "guided", undefined)).toBeUndefined();
	expect(projectSuggestion(question, undefined, { optionId: "guided", revision: 1 })).toEqual({
		draft: undefined,
	});
});
