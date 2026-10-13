import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chooseAdded, optionText, QuestionView } from "./question-view";
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

test("a read-only card, with no way to add an option, hides the trigger", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		disabled: true,
	}));

	expect(markup).not.toContain("Add an option");
});

test("a just-added option becomes this person's choice without taking a collaborator's", () => {
	let single = AUTH.questions[0]!;
	let other = single.options[0]!.id;
	let theirs = { mode: "choices" as const, choice: other, options: {}, custom: "" };
	expect(chooseAdded(single, undefined, "new", false)).toEqual({ mode: "choices", choice: "new" });
	expect(chooseAdded(single, theirs, "new", true)).toEqual({ mode: "choices", choice: "new" });
	expect(chooseAdded(single, theirs, "new", false)).toBeUndefined();

	let multiple = { ...single, multiple: true };
	let held = { mode: "choices" as const, choice: null, options: { [other]: true }, custom: "" };
	expect(chooseAdded(multiple, held, "new", false))
		.toEqual({ mode: "choices", options: { [other]: true, new: true } });
	expect(chooseAdded(multiple, undefined, "new", false))
		.toEqual({ mode: "choices", options: { new: true } });
});

test("a pasted line break in a new option becomes a space", () => {
	expect(optionText("Keep it\nsimple")).toBe("Keep it simple");
	expect(optionText("One  \r\n  two\n\nthree")).toBe("One two three");
	expect(optionText("  spaced  ")).toBe("  spaced  ");
});

test("option rows carry their id, so a just-added option can take focus", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		onAddOption: async () => ({ ok: true as const, option: "new" }),
	}));
	expect(markup).toContain(`value="${AUTH.questions[0]!.options[0]!.id}"`);
});
