/**
 * Enter, in a block that otherwise has no way out.
 *
 * Lexical asks a block to make its own successor, and one that cannot returns
 * null — which is what a code block does, and why Enter inside one did nothing
 * whatsoever. Nothing is the wrong answer twice over: a newline is the most
 * common keystroke there is when writing code, and a block at the end of the
 * document with no way past it is a corner a reader can be typed into.
 *
 * So Enter is a line break in a fence, and Enter on a line that is already
 * empty leaves instead. A callout already contains ordinary blocks, so its
 * first Enter makes an empty paragraph normally and its second removes that
 * paragraph and leaves the container. In either case, pressing Enter twice is
 * the only exit that has to be discovered rather than explained.
 *
 * Registered on `INSERT_PARAGRAPH_COMMAND` rather than on the keystroke: that
 * is what rich text turns an unshifted Enter into, and it is also what
 * everything else that means "start a new block" dispatches, so anything else
 * arriving here is answered the same way. Shift-Enter is already a line break
 * and never reaches this at all.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createParagraphNode,
	$getSelection,
	$isLineBreakNode,
	$isParagraphNode,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_LOW,
	INSERT_PARAGRAPH_COMMAND,
} from "lexical";
import { $isCalloutNode, $isCodeBlockNode, $isMathNode } from "@chopin/dialect";

import type { ElementNode, LexicalNode } from "lexical";

/**
 * The nearest block that holds lines of text.
 *
 * Inline math is not one: it sits in a sentence, and `$…$` has nowhere to put
 * a newline — so Enter inside one goes on doing what it did before, which is
 * nothing.
 */
function lines(node: LexicalNode | null): ElementNode | undefined {
	let cursor = node;
	while (cursor) {
		if ($isCodeBlockNode(cursor)) return cursor;
		if ($isMathNode(cursor)) return cursor.isInlineMath() ? undefined : cursor;
		cursor = cursor.getParent();
	}
	return undefined;
}

/** The direct callout child that contains this node. */
function calloutPosition(node: LexicalNode | null) {
	let child = node;
	while (child) {
		let parent = child.getParent();
		if ($isCalloutNode(parent)) {
			return { callout: parent, child };
		}
		child = parent;
	}
	return undefined;
}

/**
 * Whether the caret is at the end of a block that already ends in a newline.
 *
 * Both kinds of point have to be read, because the caret arrives at the end of
 * a block by two routes that do not agree on how to say so. Typing leaves it
 * inside a text node, at an offset; a line break is not text, so inserting one
 * leaves it between children, as an offset into the block itself. The second
 * is exactly the case this exists to catch — it is where the previous Enter
 * put it.
 */
function done(block: ElementNode): boolean {
	let selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

	// An empty block is not a blank line: there is nothing to leave behind yet.
	if (!block.getTextContent().endsWith("\n")) return false;

	let anchor = selection.anchor;
	if (anchor.type === "element") {
		return anchor.key === block.getKey() && anchor.offset === block.getChildrenSize();
	}

	let last = block.getLastDescendant();
	if (!last || anchor.key !== last.getKey()) return false;
	return $isTextNode(last) ? anchor.offset === last.getTextContentSize() : true;
}

export function handleEnter(): boolean {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return false;

	if (selection.isCollapsed()) {
		let position = calloutPosition(selection.anchor.getNode());
		if (position?.child.isInline()) {
			/*
			 * The old slash command stored callout prose as direct inline children.
			 * Its canonical source is valid, so restoring the Yjs checkpoint keeps
			 * that shape and Lexical asks the callout itself to handle Enter. Wrap
			 * only the inline run at the caret before asking the paragraph instead.
			 */
			let first = position.child;
			let previous = first.getPreviousSibling();
			while (previous?.isInline()) {
				first = previous;
				previous = first.getPreviousSibling();
			}

			let inline: LexicalNode[] = [];
			let cursor: LexicalNode | null = first;
			while (cursor?.isInline()) {
				inline.push(cursor);
				cursor = cursor.getNextSibling();
			}

			let paragraph = $createParagraphNode()
				.setFormat(position.callout.getFormatType())
				.setIndent(position.callout.getIndent());
			first.insertBefore(paragraph);
			paragraph.append(...inline);
			selection.insertParagraph();
			return true;
		}

		if (
			position
			&& $isParagraphNode(position.child)
			&& position.child.getTextContentSize() === 0
			&& position.child.getPreviousSibling() !== null
			&& position.child.getNextSibling() === null
		) {
			position.child.remove();
			let paragraph = $createParagraphNode();
			position.callout.insertAfter(paragraph);
			paragraph.select();
			return true;
		}
	}

	let block = lines(selection.anchor.getNode());
	if (!block) return false;

	if (done(block)) {
		// The blank line was the request to leave, not content, so
		// it goes with it — otherwise every fence anybody escaped
		// from would keep a trailing empty line nobody typed.
		let last = block.getLastDescendant();
		if ($isLineBreakNode(last)) last.remove();
		else if ($isTextNode(last)) last.setTextContent(last.getTextContent().slice(0, -1));

		let paragraph = $createParagraphNode();
		block.insertAfter(paragraph);
		paragraph.select();
		return true;
	}

	selection.insertLineBreak();
	return true;
}

export function EnterPlugin() {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		return editor.registerCommand(
			INSERT_PARAGRAPH_COMMAND,
			handleEnter,
			COMMAND_PRIORITY_LOW,
		);
	}, [editor]);

	return null;
}
