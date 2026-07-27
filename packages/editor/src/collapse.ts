/**
 * Which rendered blocks are showing their result instead of their source.
 *
 * Collapsing is a view preference, held in React state and never written to the
 * document — the same rule the tab strip follows, so hiding a diagram for
 * yourself does not hide it for everyone reading with you.
 *
 * The cursor painter needs to know about it too, and cannot reach that state
 * through React. A peer editing inside a hidden block resolves to a zero-size
 * rectangle, which does not put their caret nowhere; it puts it at an arbitrary
 * point in the document, wherever the frame happens to be scrolled to. So the
 * set is mirrored here for the painter to read.
 *
 * Keyed by editor because Lexical node keys are only unique within one, and two
 * plans open at once would otherwise hide each other's blocks.
 */

import { $isCodeBlockNode, $isMathNode } from "@chopin/dialect";

import type { LexicalEditor, LexicalNode, NodeKey } from "lexical";

const hidden = new WeakMap<LexicalEditor, ReadonlySet<NodeKey>>();

export function remember(editor: LexicalEditor, keys: ReadonlySet<NodeKey>): void {
	hidden.set(editor, keys);
}

export function collapsed(editor: LexicalEditor, key: NodeKey): boolean {
	return hidden.get(editor)?.has(key) ?? false;
}

/** The nearest block that can hide its source, if this node sits in one. */
export function enclosing(node: LexicalNode | null): NodeKey | undefined {
	let cursor = node;
	while (cursor) {
		if ($isMathNode(cursor) || $isCodeBlockNode(cursor)) return cursor.getKey();
		cursor = cursor.getParent();
	}
	return undefined;
}
