/**
 * Transport-free questionnaire views.
 *
 * Separated from the domain entry point so the VM can use the schema and CRDT
 * helpers without pulling React into a headless process.
 */

export { QuestionView } from "./question-view";
export type { Collaborator, QuestionStepRenderProps, QuestionViewProps } from "./question-view";
export { forget, useQuestionnaire } from "./use-questionnaire";
export type { QuestionnaireOptions, QuestionnaireState, Transport } from "./use-questionnaire";
