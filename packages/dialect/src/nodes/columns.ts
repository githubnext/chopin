/** Two directly editable regions in document order. */

import { $applyNodeReplacement, $getState, $setState, ElementNode, setDOMUnmanaged } from "lexical";

import { idState } from "./identity";

import type {
	EditorConfig,
	ElementDOMSlot,
	LexicalNode,
	LexicalUpdateJSON,
	SerializedElementNode,
	Spread,
} from "lexical";
import type { SerializedContainer } from "./containers";

/** Identity remains NodeState so Yjs merges child content independently. */
abstract class LayoutNode extends ElementNode {
	getId(): string {
		return $getState(this, idState);
	}

	setId(value: string): this {
		return $setState(this.getWritable(), idState, value);
	}

	override exportJSON(): Spread<{ planId: string }, SerializedElementNode> {
		return { ...super.exportJSON(), planId: this.getId() };
	}

	override updateFromJSON(serialized: LexicalUpdateJSON<SerializedContainer>): this {
		return super.updateFromJSON(serialized).setId(serialized.planId ?? "");
	}

	protected identify(dom: HTMLElement): HTMLElement {
		if (this.getId()) dom.dataset.planId = this.getId();
		return dom;
	}

	override updateDOM(): boolean {
		return false;
	}

	override isShadowRoot(): boolean {
		return false;
	}
}

export class ColumnsNode extends LayoutNode {
	static override getType(): string {
		return "plan-columns";
	}

	static override clone(node: ColumnsNode): ColumnsNode {
		return new ColumnsNode(node.__key);
	}

	static override importJSON(serialized: SerializedContainer): ColumnsNode {
		return $createColumnsNode().updateFromJSON(serialized);
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		let dom = document.createElement("section");
		dom.className = "planColumns";
		let chrome = document.createElement("div");
		chrome.dataset.planChrome = "columns";
		setDOMUnmanaged(chrome);
		dom.append(chrome);
		let content = document.createElement("div");
		content.dataset.planColumnsContent = "";
		dom.append(content);
		return this.identify(dom);
	}

	override getDOMSlot(element: HTMLElement): ElementDOMSlot {
		let content = element.querySelector<HTMLElement>("[data-plan-columns-content]");
		return super.getDOMSlot(element).withElement(content ?? element);
	}
}

export class ColumnNode extends LayoutNode {
	static override getType(): string {
		return "plan-column";
	}

	static override clone(node: ColumnNode): ColumnNode {
		return new ColumnNode(node.__key);
	}

	static override importJSON(serialized: SerializedContainer): ColumnNode {
		return $createColumnNode().updateFromJSON(serialized);
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		let dom = document.createElement("div");
		dom.className = "planColumn";
		return this.identify(dom);
	}
}

export function $createColumnsNode(id = ""): ColumnsNode {
	return $applyNodeReplacement(new ColumnsNode().setId(id));
}

export function $isColumnsNode(node: LexicalNode | null | undefined): node is ColumnsNode {
	return node instanceof ColumnsNode;
}

export function $createColumnNode(id = ""): ColumnNode {
	return $applyNodeReplacement(new ColumnNode().setId(id));
}

export function $isColumnNode(node: LexicalNode | null | undefined): node is ColumnNode {
	return node instanceof ColumnNode;
}

export const COLUMN_NODES = [ColumnsNode, ColumnNode];
