import { $createResearchNode, $isResearchNode } from "./research";
import { attribute, identity, isFlow, PRIORITY } from "./shared";

import type { LexicalExportVisitor, MdastImportVisitor } from "@mdxeditor/editor";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import type { ResearchNode } from "./research";

export const MdastResearchVisitor: MdastImportVisitor<MdxJsxFlowElement> = {
	testNode: isFlow("Research"),
	visitNode({ mdastNode, actions }) {
		actions.addAndStepInto($createResearchNode(attribute(mdastNode, "id") ?? ""));
	},
	priority: PRIORITY,
};

export const LexicalResearchVisitor: LexicalExportVisitor<
	ResearchNode,
	MdxJsxFlowElement
> = {
	testLexicalNode: $isResearchNode,
	visitLexicalNode({ lexicalNode, actions }) {
		actions.addAndStepInto("mdxJsxFlowElement", {
			name: "Research",
			attributes: identity(lexicalNode.getId()),
		});
	},
	priority: PRIORITY,
};
