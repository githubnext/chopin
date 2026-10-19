/**
 * Transport-free questionnaire views.
 *
 * Separated from the domain entry point so the VM can use the schema and CRDT
 * helpers without pulling React into a headless process.
 */

export { questionHeading, questionParts } from "../text";
export { InlineCode, InlineCodeList } from "./inline-code";
export { plainInlineList, plainInlineText } from "./inline-segments";
export { projectSuggestion, reduceSuggestionEditState } from "./project-suggestion";
export type {
	SuggestionEditAction,
	SuggestionEditState,
	SuggestionProjection,
	VisibleSuggestion,
} from "./project-suggestion";
export {
	MarkdownBlocks,
	MarkdownLine,
	MarkdownText,
	QuestionMarkdownContext,
} from "./question-markdown";
export type { QuestionMarkdownRenderer } from "./question-markdown";
export { QuestionView } from "./question-view";
export type {
	AddCriterionResult,
	AddOptionResult,
	Collaborator,
	PendingAnswers,
	QuestionStepRenderProps,
	QuestionViewProps,
} from "./question-view";
export { cardRelation, NOT_LINKED, RelationNote } from "./relation-note";
export { ResolvedActions } from "./resolved-actions";
export { forget, useQuestionnaire } from "./use-questionnaire";
export type { QuestionnaireOptions, QuestionnaireState, Transport } from "./use-questionnaire";
