import { expect, test } from "bun:test";
import { projectSuggestion } from "./project-suggestion";

const AUTH = {
	questions: [{
		id: "q",
		header: "Auth",
		question: "What auth system should we use?",
		multiple: false,
		options: [
			{ id: "a", label: "Auth0", description: "" },
			{ id: "b", label: "GitHub Apps", description: "" },
		],
	}],
};

test("a visible suggestion preserves its exact revision snapshot", () => {
	let draft = {
		mode: "choices" as const,
		choice: null,
		options: { a: false, b: false },
		custom: "",
	};
	let suggestion = { optionId: "b", revision: 7 };
	let projection = projectSuggestion(AUTH.questions[0], draft, suggestion);

	expect(projection.draft?.choice).toBe("b");
	expect(projection.suggestion).toBe(suggestion);
});

test("human choices and local edits take precedence over later suggestions", () => {
	let selected = {
		mode: "choices" as const,
		choice: "a",
		options: { a: false, b: false },
		custom: "",
	};
	let newer = { optionId: "a", revision: 8 };
	let unsent = { ...selected, choice: null };
	let humanChoice = projectSuggestion(AUTH.questions[0], selected, newer);
	let queuedEdit = projectSuggestion(AUTH.questions[0], unsent, newer, true);

	expect(humanChoice.draft).toBe(selected);
	expect(humanChoice.suggestion).toBeUndefined();
	expect(queuedEdit.draft).toBe(unsent);
	expect(queuedEdit.suggestion).toBeUndefined();
});
