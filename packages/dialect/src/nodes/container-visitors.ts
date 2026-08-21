/**
 * MDAST <-> Lexical visitors for the structural plan components.
 *
 * Children are visited normally in both directions, so their content is made of
 * ordinary Lexical nodes and ordinary MDAST nodes — nothing is snapshotted into
 * a property, which is what keeps concurrent editing inside these containers
 * working.
 */

import {
	$createCalloutNode,
	$createResearchQuestionNode,
	$createTabNode,
	$createTabsNode,
	$isCalloutNode,
	$isResearchQuestionNode,
	$isTabNode,
	$isTabsNode,
} from "./containers";
import { attribute, identity, isFlow, PRIORITY } from "./shared";

import type { LexicalExportVisitor, MdastImportVisitor } from "@mdxeditor/editor";
import type { LexicalNode } from "lexical";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import type {
	CalloutNode,
	CalloutType,
	ResearchQuestionNode,
	TabNode,
	TabsNode,
} from "./containers";

type Importer = MdastImportVisitor<MdxJsxFlowElement>;
type Exporter<T extends LexicalNode> = LexicalExportVisitor<T, MdxJsxFlowElement>;

/** Import a flow component as an element node and visit its children into it. */
function importer(name: string, create: (node: MdxJsxFlowElement) => LexicalNode): Importer {
	return {
		testNode: isFlow(name),
		visitNode({ mdastNode, actions }) {
			actions.addAndStepInto(create(mdastNode));
		},
		priority: PRIORITY,
	};
}

/** Export an element node as a flow component and visit its children into it. */
function exporter<T extends LexicalNode>(
	name: string,
	test: (node: LexicalNode | null | undefined) => node is T,
	attrs: (node: T) => ReturnType<typeof identity>,
): Exporter<T> {
	return {
		testLexicalNode: (node): node is T => test(node),
		visitLexicalNode({ lexicalNode, actions }) {
			actions.addAndStepInto("mdxJsxFlowElement", { name, attributes: attrs(lexicalNode) });
		},
		priority: PRIORITY,
	};
}

export const MdastTabsVisitor = importer(
	"Tabs",
	node => $createTabsNode(attribute(node, "id") ?? ""),
);

export const MdastTabVisitor = importer(
	"Tab",
	node => $createTabNode(attribute(node, "id") ?? "", attribute(node, "label") ?? ""),
);

export const MdastCalloutVisitor = importer("Callout", node =>
	$createCalloutNode(
		attribute(node, "id") ?? "",
		(attribute(node, "type") ?? "note") as CalloutType,
		attribute(node, "title") ?? "",
	));

export const MdastResearchQuestionVisitor = importer(
	"ResearchQuestion",
	node => $createResearchQuestionNode(attribute(node, "id") ?? ""),
);

export const LexicalTabsVisitor: Exporter<TabsNode> = exporter(
	"Tabs",
	$isTabsNode,
	node => identity(node.getId()),
);

export const LexicalTabVisitor: Exporter<TabNode> = exporter(
	"Tab",
	$isTabNode,
	node => identity(node.getId(), { label: node.getLabel() }),
);

export const LexicalCalloutVisitor: Exporter<CalloutNode> = exporter(
	"Callout",
	$isCalloutNode,
	node => identity(node.getId(), { type: node.getCalloutType(), title: node.getTitle() }),
);

export const LexicalResearchQuestionVisitor: Exporter<ResearchQuestionNode> = exporter(
	"ResearchQuestion",
	$isResearchQuestionNode,
	node => identity(node.getId()),
);

export const CONTAINER_IMPORT_VISITORS = [
	MdastTabsVisitor,
	MdastTabVisitor,
	MdastCalloutVisitor,
	MdastResearchQuestionVisitor,
];

export const CONTAINER_EXPORT_VISITORS = [
	LexicalTabsVisitor,
	LexicalTabVisitor,
	LexicalCalloutVisitor,
	LexicalResearchQuestionVisitor,
];
