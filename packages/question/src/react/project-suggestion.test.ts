import { expect, test } from "bun:test";
import { projectSuggestion, reduceSuggestionEditState } from "./project-suggestion";

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

// Whole archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("cancelling the option composer restores suggestions without undoing answer edits", () => {
	let initial = {
		answer: false,
		composer: false,
		suggestionPresent: false,
		suggestionGeneration: 0,
	};
	let composing = reduceSuggestionEditState(initial, { type: "composer-edited" });
	let cancelled = reduceSuggestionEditState(composing, { type: "composer-cancelled" });
	let visibleSuggestion = reduceSuggestionEditState(composing, { type: "suggestion-visible" });
	let committed = reduceSuggestionEditState(visibleSuggestion, { type: "composer-committed" });
	let clearedBeforeCommit = reduceSuggestionEditState(
		reduceSuggestionEditState(visibleSuggestion, { type: "suggestion-cleared" }),
		{ type: "composer-committed" },
	);
	let answerThenComposer = reduceSuggestionEditState(
		reduceSuggestionEditState(initial, { type: "answer-edited" }),
		{ type: "composer-edited" },
	);
	let answerKept = reduceSuggestionEditState(answerThenComposer, { type: "composer-cancelled" });
	let cleared = reduceSuggestionEditState(answerKept, { type: "suggestion-cleared" });
	let suggestion = { optionId: "b", revision: 7 };

	expect(cancelled.composer).toBe(false);
	expect(cancelled.answer).toBe(false);
	expect(answerKept.answer).toBe(true);
	expect(answerKept.composer).toBe(false);
	expect(committed.answer).toBe(true);
	expect(committed.composer).toBe(false);
	expect(clearedBeforeCommit.answer).toBe(false);
	expect(clearedBeforeCommit.composer).toBe(false);
	expect(cleared.answer).toBe(false);
	expect(
		projectSuggestion(
			AUTH.questions[0],
			undefined,
			suggestion,
			cancelled.answer || cancelled.composer,
		)
			.suggestion,
	).toBe(suggestion);
	expect(
		projectSuggestion(
			AUTH.questions[0],
			undefined,
			suggestion,
			answerKept.answer || answerKept.composer,
		)
			.suggestion,
	).toBeUndefined();
	expect(
		projectSuggestion(
			AUTH.questions[0],
			undefined,
			suggestion,
			clearedBeforeCommit.answer || clearedBeforeCommit.composer,
		)
			.suggestion,
	).toBe(suggestion);
});

test("option composer text entered before a suggestion keeps it from replacing the edit", () => {
	let initial = {
		answer: false,
		composer: false,
		suggestionPresent: false,
		suggestionGeneration: 0,
	};
	let composing = reduceSuggestionEditState(initial, { type: "composer-edited" });
	let published = reduceSuggestionEditState(composing, { type: "suggestion-visible" });
	let cancelled = reduceSuggestionEditState(published, { type: "composer-cancelled" });
	let suggestion = { optionId: "b", revision: 7 };

	expect(
		projectSuggestion(
			AUTH.questions[0],
			undefined,
			suggestion,
			published.answer || published.composer,
		).suggestion,
	).toBeUndefined();
	expect(
		projectSuggestion(
			AUTH.questions[0],
			undefined,
			suggestion,
			cancelled.answer || cancelled.composer,
		).suggestion,
	).toBe(suggestion);
});
