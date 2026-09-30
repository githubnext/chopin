import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionView } from "./question-view";
import type { Draft } from "../draft";

// Original callbacks/fixture: archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// packages/question/src/react/question-view.test.ts:26.
import { AUTH } from "./question-view.test-fixtures";

test("an open option includes its rationale in the clickable label", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: {
			questions: [{
				...AUTH.questions[0],
				options: [
					{ id: "a", label: "Auth0", description: "Uses an external identity provider." },
					{ id: "b", label: "GitHub Apps", description: "" },
				],
			}],
		},
		drafts: {},
	}));

	let choices = markup.match(/<label[^>]*>.*?<\/label>/g) ?? [];
	expect(choices[0]).toContain("Auth0");
	expect(choices[0]).toContain("Uses an external identity provider.");
	expect(choices[0]).toContain('class="block text-sm text-text-secondary"');
	expect(choices[0]).not.toContain('aria-hidden="true">Uses an external identity provider');
	expect(choices[1]).toContain("GitHub Apps");
	expect(choices[1]).not.toContain('class="block text-sm text-text-secondary"');
});

function empty(): Draft {
	return { mode: "choices", choice: null, options: { a: false, b: false }, custom: "" };
}

function markup(draft: Draft | undefined, optionId = "b", disabled = false) {
	return renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: draft ? { q: draft } : {},
		suggested: { optionId, revision: 7 },
		onSubmit: () => {},
		disabled,
	}));
}

test("an empty single-card answer is not ready to save", () => {
	let rendered = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: { q: empty() },
		onSubmit: () => {},
	}));
	expect(rendered).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Save answer</);
});

test("a suggestion selects the existing radio without writing the shared draft", () => {
	let draft = empty();
	let before = structuredClone(draft);
	let rendered = markup(draft);
	let radios = rendered.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
	expect(radios[0]).not.toContain('checked=""');
	expect(radios[1]).toContain('checked=""');
	expect(rendered).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Save answer</);
	expect(draft).toEqual(before);
});

test("a human option selection keeps priority over a suggestion", () => {
	let rendered = markup({ ...empty(), choice: "a" });
	let radios = rendered.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
	expect(radios[0]).toContain('checked=""');
	expect(radios[1]).not.toContain('checked=""');
});

test("a human custom answer keeps priority over a suggestion", () => {
	let rendered = markup({ ...empty(), mode: "custom", custom: "Use our own" });
	let radios = rendered.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
	expect(radios[1]).not.toContain('checked=""');
	expect(radios[2]).toContain('checked=""');
	expect(rendered).toContain("Use our own</textarea>");
});

test("an unknown suggested ID cannot make an empty draft ready to save", () => {
	let rendered = markup(empty(), "removed");
	expect(rendered).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Save answer</);
});

test("a read-only view keeps projected suggestions disabled", () => {
	let rendered = markup(empty(), "b", true);
	let radios = rendered.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
	expect(radios[1]).toContain('checked=""');
	expect(radios[1]).toContain('disabled=""');
	expect(rendered).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Save answer</);
});

test("legacy multi-question navigation does not project a single-card suggestion", () => {
	let rendered = renderToStaticMarkup(createElement(QuestionView, {
		definition: { questions: [AUTH.questions[0]!, { ...AUTH.questions[0]!, id: "other" }] },
		drafts: { q: empty() },
		suggested: { optionId: "b", revision: 7 },
		onSubmit: () => {},
	}));
	let radios = rendered.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
	expect(radios[1]).not.toContain('checked=""');
	expect(rendered).toContain('role="tablist"');
});
