import type { Draft } from "../draft";
import type { Item } from "../schema";

export type VisibleSuggestion = { optionId: string; revision: number };

export type SuggestionProjection = { draft?: Draft; suggestion?: VisibleSuggestion };

export function projectSuggestion(
	question: Item,
	draft: Draft | undefined,
	suggestion: VisibleSuggestion | undefined,
	suppressed = false,
): SuggestionProjection {
	if (
		!suggestion || suppressed || question.multiple
		|| !question.options.some(option => option.id === suggestion.optionId)
	) return { draft };

	let untouched = !draft || (
		draft.mode === "choices" && draft.choice === null && draft.custom.length === 0
		&& !Object.values(draft.options).some(Boolean)
	);
	if (!untouched) return { draft };

	let empty: Draft = draft ?? {
		mode: "choices",
		choice: null,
		options: Object.fromEntries(question.options.map(option => [option.id, false])),
		custom: "",
	};
	// Keep the original snapshot so Save submits the revision that was displayed.
	return {
		draft: { ...empty, mode: "choices", choice: suggestion.optionId },
		suggestion,
	};
}

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2 suggestion edit lifecycle.
export type SuggestionEditState = {
	answer: boolean;
	composer: boolean;
	composerGeneration?: number;
	suggestionPresent: boolean;
	suggestionGeneration: number;
};

export type SuggestionEditAction =
	| { type: "answer-edited" }
	| { type: "composer-edited" }
	| { type: "composer-cancelled" }
	| { type: "composer-committed" }
	| { type: "suggestion-visible" }
	| { type: "suggestion-cleared" };

export function reduceSuggestionEditState(
	state: SuggestionEditState,
	action: SuggestionEditAction,
): SuggestionEditState {
	switch (action.type) {
		case "answer-edited":
			return { ...state, answer: true };
		case "composer-edited":
			return {
				...state,
				composer: true,
				composerGeneration: state.suggestionGeneration,
			};
		case "composer-cancelled":
			return { ...state, composer: false, composerGeneration: undefined };
		case "composer-committed":
			if (!state.composer) return state;
			return {
				...state,
				answer: state.answer || (
					state.suggestionPresent
					&& state.composerGeneration === state.suggestionGeneration
				),
				composer: false,
				composerGeneration: undefined,
			};
		case "suggestion-visible":
			return { ...state, suggestionPresent: true };
		case "suggestion-cleared":
			return {
				...state,
				answer: false,
				suggestionPresent: false,
				suggestionGeneration: state.suggestionPresent
					? state.suggestionGeneration + 1
					: state.suggestionGeneration,
			};
	}
}
