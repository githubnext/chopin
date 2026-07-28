/**
 * The plan MDX dialect: parsing, validation and canonical serialisation.
 *
 * Shared by the browser editor and the server so both agree on exactly what a
 * plan may contain and how it is written back out.
 */

export * as limits from "./limits";

export {
	CALLOUT_TYPES,
	COMPONENT_NAMES,
	COMPONENTS,
	IMAGE_PROTOCOLS,
	LINK_PROTOCOLS,
	lookup,
	MERMAID_LANGUAGE,
} from "./dialect";
export type { Attribute, Component, Content, Kind } from "./dialect";

export { parse, PlanParseError } from "./parse";
export { serialize } from "./serialize";
export { assert, PlanValidationError, validate } from "./validate";
export type { Issue, Options as ValidateOptions, Result as ValidateResult } from "./validate";

export {
	$createPlanNodes,
	$exportPlan,
	$exportPlanTree,
	$importPlan,
	exportPlan,
	importPlan,
} from "./convert";
export type { ConvertOptions } from "./convert";
export { plugins, registry, tablePlugin } from "./registry";
export type { Registry } from "./registry";

export {
	$createCalloutNode,
	$createTabNode,
	$createTabsNode,
	$isCalloutNode,
	$isTabNode,
	$isTabsNode,
	CalloutNode,
	TabNode,
	TabsNode,
} from "./nodes/containers";
export type { CalloutType } from "./nodes/containers";
export {
	$createCodeBlockNode,
	$createFootnoteDefinitionNode,
	$createFootnoteReferenceNode,
	$createImageNode,
	$createMathNode,
	$isCodeBlockNode,
	$isFootnoteDefinitionNode,
	$isFootnoteReferenceNode,
	$isImageNode,
	$isMathNode,
	CodeBlockNode,
	FootnoteDefinitionNode,
	FootnoteReferenceNode,
	ImageNode,
	MathNode,
} from "./nodes/content";

export {
	$createQuestionnaireNode,
	$isQuestionnaireNode,
	QuestionnaireNode,
} from "./nodes/questionnaire";
export type { Option, Question, Questionnaire } from "./nodes/questionnaire";

export { $createDecisionNode, $isDecisionNode, DecisionNode } from "./nodes/decision";
export type { Decision, Note } from "./nodes/decision";

export { render, setRenderer } from "./nodes/render";
export type { Renderer } from "./nodes/render";

export { ULID, ulid } from "./ulid";
