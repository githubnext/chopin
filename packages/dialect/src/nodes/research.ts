import { $applyNodeReplacement, $getState, $setState, DecoratorNode } from "lexical";

import { idState } from "./identity";
import { render } from "./render";

import type { LexicalNode, LexicalUpdateJSON, SerializedLexicalNode, Spread } from "lexical";

export type SerializedResearch = Spread<{ planId: string }, SerializedLexicalNode>;

/** Atomic reference to Research Workspace state owned outside the document. */
export class ResearchNode extends DecoratorNode<unknown> {
	static override getType(): string {
		return "plan-research";
	}

	static override clone(node: ResearchNode): ResearchNode {
		return new ResearchNode(node.__key);
	}

	static override importJSON(serialized: SerializedResearch): ResearchNode {
		return $createResearchNode().updateFromJSON(serialized);
	}

	getId(): string {
		return $getState(this, idState);
	}

	setId(value: string): this {
		return $setState(this.getWritable(), idState, value);
	}

	override exportJSON(): SerializedResearch {
		return { ...super.exportJSON(), planId: this.getId() };
	}

	override updateFromJSON(serialized: LexicalUpdateJSON<SerializedResearch>): this {
		return super.updateFromJSON(serialized).setId(serialized.planId ?? "");
	}

	override createDOM(): HTMLElement {
		let dom = document.createElement("div");
		dom.dataset.planResearch = this.getId();
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

export function $createResearchNode(id = ""): ResearchNode {
	return $applyNodeReplacement(new ResearchNode().setId(id));
}

export function $isResearchNode(
	node: LexicalNode | null | undefined,
): node is ResearchNode {
	return node instanceof ResearchNode;
}
