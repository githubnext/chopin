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
	DIFF_LANGUAGE,
	IMAGE_PROTOCOLS,
	LINK_PROTOCOLS,
	lookup,
	MERMAID_LANGUAGE,
} from "./dialect";
export type { Attribute, Component, Content, Kind } from "./dialect";

export { topLevelChunks } from "./chunk";
export type { MdxChunk } from "./chunk";
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
export { $createResearchNode, $isResearchNode, ResearchNode } from "./nodes/research";
export type { SerializedResearch } from "./nodes/research";

export {
	$createQuestionnaireNode,
	$isQuestionnaireNode,
	QuestionnaireNode,
} from "./nodes/questionnaire";
export type { Option, Question, Questionnaire } from "./nodes/questionnaire";

export { $createDecisionNode, $isDecisionNode, DecisionNode } from "./nodes/decision";
export type { Decision, Note } from "./nodes/decision";

/*
 * A `createState` handle is an identity, not a description: state written under
 * one is invisible to another built from the same arguments. The UI that edits
 * column alignment has to use this exact one, so it is exported rather than
 * redeclared.
 */
export { alignState } from "./nodes/table";
export type { Align } from "./nodes/table";

export { render, setRenderer } from "./nodes/render";
export type { Renderer } from "./nodes/render";

export { ULID, ulid } from "./ulid";
