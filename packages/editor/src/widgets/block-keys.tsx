/**
 * Notion's keys for a whole block: Mod+Shift+ArrowUp and ArrowDown move the block holding the
 * caret past its neighbour, Mod+D puts a copy of it after it, and `---` typed on an empty line
 * draws a divider there. Mod+E marks the selection as inline code.
 *
 * A block is the caret's line where blocks are siblings: a paragraph or heading in the document,
 * a callout, a column or a tab, or an item in its list. The title stays first, so nothing moves
 * past it. A copy is made only of a block that is its own text: anything holding a component
 * (a decision, a mention, an image) has an identity a copy would claim twice.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createListNode, $isListItemNode, $isListNode } from "@lexical/list";
import {
	$createHorizontalRuleNode,
	$isHorizontalRuleNode,
} from "@lexical/react/LexicalHorizontalRuleNode";
import { $isTableNode } from "@lexical/table";
import { $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import {
	$createParagraphNode,
	$getSelection,
	$isDecoratorNode,
	$isElementNode,
	$isParagraphNode,
	$isRangeSelection,
	$isRootNode,
	$parseSerializedNode,
	COMMAND_PRIORITY_CRITICAL,
	COMMAND_PRIORITY_LOW,
	FORMAT_TEXT_COMMAND,
	KEY_BACKSPACE_COMMAND,
	KEY_DOWN_COMMAND,
	OUTDENT_CONTENT_COMMAND,
} from "lexical";
import {
	$isCalloutNode,
	$isCodeBlockNode,
	$isColumnNode,
	$isMathNode,
	$isTabNode,
} from "@chopin/dialect";

import { $isDocumentTitle } from "../document-title";
import { isApplePlatform } from "../toolbar/shortcut";

import type { LexicalEditor, LexicalNode, SerializedLexicalNode } from "lexical";

/** Where blocks sit side by side, so one can move among the others. */
function $holdsBlocks(node: LexicalNode | null): boolean {
	return $isRootNode(node) || $isCalloutNode(node) || $isColumnNode(node) || $isTabNode(node)
		|| $isListNode(node);
}

/** The block the caret is in, if it is one that moves. */
export function $caretBlock(): LexicalNode | undefined {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return undefined;
	for (let at: LexicalNode | null = selection.anchor.getNode(); at; at = at.getParent()) {
		if ($holdsBlocks(at.getParent())) return $isDocumentTitle(at) ? undefined : at;
	}
	return undefined;
}

/** Move a block past its neighbour; false where there is none to pass, or it is the title. */
export function $moveBlock(block: LexicalNode, direction: "up" | "down"): boolean {
	let neighbour = direction === "up" ? block.getPreviousSibling() : block.getNextSibling();
	if (!neighbour || $isDocumentTitle(neighbour)) return false;
	if (direction === "up") neighbour.insertBefore(block);
	else neighbour.insertAfter(block);
	return true;
}

export type SerializedBlock = SerializedLexicalNode & { children?: SerializedBlock[] };

/** A block and everything in it, as Lexical's own JSON. */
export function $serializeBlock(node: LexicalNode): SerializedBlock {
	let json: SerializedBlock = node.exportJSON();
	return $isElementNode(node)
		? { ...json, children: node.getChildren().map($serializeBlock) }
		: json;
}

/**
 * Whether a block is its own text, so a copy of it is a new block rather than a second claim to
 * an identity: text, a heading, a quote, a list item, code, a divider, a table or a formula,
 * holding nothing but text and links. A decision, a mention, an image, a footnote or a callout
 * has an identity a copy would claim twice.
 */
export function $plainBlock(block: LexicalNode): boolean {
	if ($isHorizontalRuleNode(block)) return true;
	let plain = $isParagraphNode(block) || $isHeadingNode(block) || $isQuoteNode(block)
		|| $isListItemNode(block) || $isCodeBlockNode(block) || $isTableNode(block)
		|| $isMathNode(block);
	if (!plain || !$isElementNode(block)) return false;
	return !block.getChildren().some(function holds(child): boolean {
		return $isDecoratorNode(child) || ($isElementNode(child) && child.getChildren().some(holds));
	});
}

/** Put a copy of a block after it, with the caret at the copy's end. */
export function $duplicateBlock(block: LexicalNode): boolean {
	if (!$plainBlock(block)) return false;
	let copy = $parseSerializedNode($serializeBlock(block));
	block.insertAfter(copy);
	if ($isElementNode(copy)) copy.selectEnd();
	return true;
}

/** `---` on an empty line: the line becomes a divider with an empty line after it. */
function $divider(): boolean {
	let selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
	let node = selection.anchor.getNode();
	let line = $isParagraphNode(node) ? node : node.getParent();
	if (!$isParagraphNode(line) || !$holdsBlocks(line.getParent()) || $isListNode(line.getParent())) {
		return false;
	}
	if (line.getTextContent() !== "--" || selection.anchor.offset !== 2) return false;
	line.clear();
	line.insertBefore($createHorizontalRuleNode());
	line.select();
	return true;
}

/**
 * Backspace at the very start of a heading or a list item makes it text first, as Notion does; the
 * next Backspace merges it with the block above. A nested item moves out a level instead. The
 * title is not turned: it stays the title.
 */
export function $unformat(editor: LexicalEditor): boolean {
	let selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.offset !== 0) {
		return false;
	}
	let node = selection.anchor.getNode();
	let block = $isElementNode(node) && !node.isInline() ? node : node.getParent();
	for (let at: LexicalNode | null = node; at && !at.is(block); at = at.getParent()) {
		if (at.getPreviousSibling()) return false;
	}
	if ($isHeadingNode(block) && !$isDocumentTitle(block)) {
		let paragraph = $createParagraphNode();
		block.replace(paragraph, true);
		paragraph.selectStart();
		return true;
	}
	if (!$isListItemNode(block)) return false;
	let list = block.getParent();
	if (!$isListNode(list)) return false;
	if ($isListItemNode(list.getParent())) {
		editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
		return true;
	}
	let paragraph = $createParagraphNode();
	paragraph.append(...block.getChildren());
	let after = block.getNextSiblings();
	if (after.length > 0) {
		let rest = $createListNode(list.getListType());
		rest.append(...after);
		list.insertAfter(rest);
	}
	list.insertAfter(paragraph);
	block.remove();
	if (list.isAttached() && list.getChildrenSize() === 0) list.remove();
	paragraph.selectStart();
	return true;
}

export function registerBlockKeys(editor: LexicalEditor): () => void {
	let apple = isApplePlatform();
	let backspace = editor.registerCommand(
		KEY_BACKSPACE_COMMAND,
		event => {
			if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
			if (!$unformat(editor)) return false;
			event.preventDefault();
			return true;
		},
		// Ahead of the title's guard, which would refuse it for a block straight under the title.
		COMMAND_PRIORITY_CRITICAL,
	);
	let keys = editor.registerCommand(
		KEY_DOWN_COMMAND,
		event => {
			let mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
			if (mod && event.shiftKey && !event.altKey) {
				if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
				let block = $caretBlock();
				if (!block || !$moveBlock(block, event.key === "ArrowUp" ? "up" : "down")) return false;
				event.preventDefault();
				return true;
			}
			if (mod && !event.shiftKey && !event.altKey) {
				let key = event.key.toLowerCase();
				if (key === "d") {
					let block = $caretBlock();
					if (!block || !$duplicateBlock(block)) return false;
					event.preventDefault();
					return true;
				}
				if (key === "e") {
					event.preventDefault();
					editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code");
					return true;
				}
				return false;
			}
			if (event.key === "-" && !mod && !event.altKey && $divider()) {
				event.preventDefault();
				return true;
			}
			return false;
		},
		COMMAND_PRIORITY_LOW,
	);
	return () => {
		backspace();
		keys();
	};
}

export function BlockKeysPlugin() {
	let [editor] = useLexicalComposerContext();
	useEffect(() => registerBlockKeys(editor), [editor]);
	return null;
}
