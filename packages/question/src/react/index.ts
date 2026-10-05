/**
 * Transport-free questionnaire views.
 *
 * Separated from the domain entry point so the VM can use the schema and CRDT
 * helpers without pulling React into a headless process.
 */

export { InlineCode } from "./inline-code";
export { plainInlineText } from "./inline-segments";
export { projectSuggestion, reduceSuggestionEditState } from "./project-suggestion";
export type {
	SuggestionEditAction,
	SuggestionEditState,
	SuggestionProjection,
	VisibleSuggestion,
} from "./project-suggestion";
export { QuestionView } from "./question-view";
export type {
	AddOptionResult,
	Collaborator,
	QuestionStepRenderProps,
	QuestionViewProps,
} from "./question-view";
export { ResolvedActions } from "./resolved-actions";
export { forget, useQuestionnaire } from "./use-questionnaire";
export type { QuestionnaireOptions, QuestionnaireState, Transport } from "./use-questionnaire";
