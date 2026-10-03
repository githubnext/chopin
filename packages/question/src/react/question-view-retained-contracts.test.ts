import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionView } from "./question-view";
import type { AddOptionResult } from "./question-view";
import { AUTH } from "./question-view.test-fixtures";

// Six deferred original contracts, using main's current anatomy and canonical statuses.
function save(markup: string): string {
	let button = markup.match(/<button[^>]*>Save<\/button>/)?.[0];
	if (!button) throw new Error("The real Save control is missing");
	return button;
}

test("a discarded multi-card names the questions set aside", () => {
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
		resolver: "ben",
		status: "discarded",
	}));
	expect(markup).toContain(
		"Discarded by @ben — What auth system should we use?, What belongs in the first cut?",
	);
	expect(markup.split("@ben")).toHaveLength(2);
	expect(markup).not.toContain('type="radio"');
});

test("a discarded single card does not repeat its title", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		resolver: "ben",
		status: "discarded",
	}));
	expect(markup).toContain("Discarded by @ben");
	expect(markup.split(AUTH.questions[0].question)).toHaveLength(2);
	expect(markup).not.toContain("Cancelled");
});

test("a single decision renders the card anatomy", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: { q: { mode: "choices", choice: "b", options: { a: false, b: false }, custom: "" } },
		onSubmit: () => {},
		onDiscard: () => {},
		onAddOption: async (): Promise<AddOptionResult> => ({ ok: true }),
		collaborators: [{ client: "ben-browser", handle: "ben", question: "q" }],
		aside: createElement("span", {}, "Opened by @ana"),
	}));
	let choices = markup.match(/<label[^>]*>[\s\S]*?<\/label>/g) ?? [];

	expect(markup).toContain('title="Decision"');
	expect(markup).toMatch(/<h4[^>]*><span[^>]*>What auth system should we use\?<\/span><\/h4>/);
	expect(markup).toContain('<fieldset class="question-options">');
	expect(choices).toHaveLength(2);
	expect(choices[0]).not.toContain('checked=""');
	expect(choices[1]).toMatch(/checked=""[\s\S]*GitHub Apps/);
	expect(markup).toMatch(
		/<button[^>]*class="[^"]*question-add"[^>]*>[\s\S]*?Add an option<\/span><\/button>/,
	);
	expect(markup).toContain(">Discard<");
	expect(save(markup)).not.toContain('disabled=""');
	expect(markup).toContain('aria-label="Editing this question"');
	expect(markup).toContain("@ben");
	expect(markup).toContain("Opened by @ana");
	expect(markup).not.toContain("Write a custom answer");
	expect(markup).not.toContain("<textarea");
});

test("a suggested option is selected, tagged from chat and ready to save", () => {
	let drafts = {};
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts,
		onSubmit: () => {},
		suggested: { optionId: "b", revision: 7 },
	}));
	let choices = markup.match(/<label[^>]*>[\s\S]*?<\/label>/g) ?? [];

	expect(choices[1]).toMatch(/checked=""[\s\S]*GitHub Apps[\s\S]*from chat/);
	expect(save(markup)).not.toContain('disabled=""');
	expect(drafts).toEqual({});
});

test("a linked decision keeps its heading outside the related-prose button", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		places: { q: 2 },
		onQuestionSelect() {},
	}));
	let button = markup.match(/<button[^>]*data-ace-question-id="q"[^>]*>[\s\S]*?<\/button>/)?.[0];

	expect(markup).toMatch(/<h4[^>]*><button[^>]*data-ace-question-id="q"/);
	expect(button).toBeDefined();
	expect(button).not.toMatch(/<h[1-6]\b/);
	expect(button).toContain('aria-label="What auth system should we use? — show in plan, 2 places"');
});

test("Save is disabled until something is chosen", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: { q: { mode: "choices", choice: null, options: { a: false, b: false }, custom: "" } },
		onSubmit: () => {},
	}));

	expect(save(markup)).toContain('disabled=""');
});
