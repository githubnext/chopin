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
	let [first, second] = single.options.map(option => option.id);
	let holding = (choice: string) => ({ mode: "choices" as const, choice, options: {}, custom: "" });
	expect(chooseAdded(single, undefined, "new", undefined)).toEqual({
		mode: "choices",
		choice: "new",
	});
	// Still holding this person's pick: theirs to move.
	expect(chooseAdded(single, holding(first!), "new", first)).toEqual({
		mode: "choices",
		choice: "new",
	});
	// A collaborator chose since, or this person never chose here: left alone.
	expect(chooseAdded(single, holding(second!), "new", first)).toBeUndefined();
	expect(chooseAdded(single, holding(first!), "new", undefined)).toBeUndefined();
	// Cleared answers are open to the new option.
	expect(chooseAdded(single, { ...holding(first!), choice: null }, "new", first))
		.toEqual({ mode: "choices", choice: "new" });

	let multiple = { ...single, multiple: true };
	let held = { mode: "choices" as const, choice: null, options: { [first!]: true }, custom: "" };
	expect(chooseAdded(multiple, held, "new", undefined))
		.toEqual({ mode: "choices", options: { [first!]: true, new: true } });
	expect(chooseAdded(multiple, undefined, "new", undefined))
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
