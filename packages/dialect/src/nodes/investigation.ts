import { $applyNodeReplacement, $getState, $setState, DecoratorNode } from "lexical";

import { idState } from "./identity";
import { render } from "./render";
import { attribute, identity, isFlow, PRIORITY } from "./shared";

import type { LexicalNode, LexicalUpdateJSON, SerializedLexicalNode, Spread } from "lexical";
import type { LexicalExportVisitor, MdastImportVisitor } from "@mdxeditor/editor";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";

export type SerializedInvestigation = Spread<{ planId: string }, SerializedLexicalNode>;

/** Atomic reference to a local investigation whose state lives in its own record. */
export class InvestigationNode extends DecoratorNode<unknown> {
	static override getType(): string {
		return "plan-investigation";
	}

	static override clone(node: InvestigationNode): InvestigationNode {
		return new InvestigationNode(node.__key);
	}

	static override importJSON(serialized: SerializedInvestigation): InvestigationNode {
		return $createInvestigationNode().updateFromJSON(serialized);
	}

	getId(): string {
		return $getState(this, idState);
	}

	setId(value: string): this {
		return $setState(this.getWritable(), idState, value);
	}

	override exportJSON(): SerializedInvestigation {
		return { ...super.exportJSON(), planId: this.getId() };
	}

	override updateFromJSON(serialized: LexicalUpdateJSON<SerializedInvestigation>): this {
		return super.updateFromJSON(serialized).setId(serialized.planId ?? "");
	}

	override createDOM(): HTMLElement {
		let dom = document.createElement("div");
		dom.dataset.planInvestigation = this.getId();
		return dom;
	}

	override updateDOM(): boolean {
		return false;
	}

	override isInline(): boolean {
		return false;
	}

	override isKeyboardSelectable(): boolean {
		return true;
	}

	override decorate(): unknown {
		return render(this);
	}
}

export function $createInvestigationNode(id = ""): InvestigationNode {
	return $applyNodeReplacement(new InvestigationNode().setId(id));
}

export function $isInvestigationNode(
	node: LexicalNode | null | undefined,
): node is InvestigationNode {
	return node instanceof InvestigationNode;
}

export const MdastInvestigationVisitor: MdastImportVisitor<MdxJsxFlowElement> = {
	testNode: isFlow("Investigation"),
	visitNode({ mdastNode, actions }) {
		actions.addAndStepInto($createInvestigationNode(attribute(mdastNode, "id") ?? ""));
	},
	priority: PRIORITY,
};

export const LexicalInvestigationVisitor: LexicalExportVisitor<
	InvestigationNode,
	MdxJsxFlowElement
> = {
	testLexicalNode: $isInvestigationNode,
	visitLexicalNode({ lexicalNode, actions }) {
		actions.addAndStepInto("mdxJsxFlowElement", {
			name: "Investigation",
			attributes: identity(lexicalNode.getId()),
		});
	},
	priority: PRIORITY,
};
