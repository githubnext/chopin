import { $isRootNode } from "lexical";

import type { LexicalNode } from "lexical";

/** True when a caret at this text node's start is also at its block's start. */
export function atBlockStart(node: LexicalNode): boolean {
	let current = node;
	while (true) {
		let parent = current.getParent();
		if (!parent) return false;
		if ($isRootNode(parent)) return true;
		if (current.getPreviousSibling()) return false;
		current = parent;
	}
}

/** True when a caret at this text node's end is also at its block's end. */
export function atBlockEnd(node: LexicalNode): boolean {
	let current = node;
	while (true) {
		let parent = current.getParent();
		if (!parent) return false;
		if ($isRootNode(parent)) return true;
		if (current.getNextSibling()) return false;
		current = parent;
	}
}
