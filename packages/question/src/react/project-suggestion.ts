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
