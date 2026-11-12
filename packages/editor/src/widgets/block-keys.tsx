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
import { $isListItemNode, $isListNode } from "@lexical/list";
import { $createHorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import {
	$getSelection,
	$isDecoratorNode,
	$isElementNode,
	$isParagraphNode,
	$isRangeSelection,
	$isRootNode,
	$parseSerializedNode,
	COMMAND_PRIORITY_LOW,
	FORMAT_TEXT_COMMAND,
	KEY_DOWN_COMMAND,
} from "lexical";
import { $isCalloutNode, $isCodeBlockNode, $isColumnNode, $isTabNode } from "@chopin/dialect";

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

type Serialized = SerializedLexicalNode & { children?: Serialized[] };

function serialize(node: LexicalNode): Serialized {
	let json: Serialized = node.exportJSON();
	return $isElementNode(node) ? { ...json, children: node.getChildren().map(serialize) } : json;
}

/** Whether a copy of a block would be a new block rather than a second claim to an identity. */
function $copyable(block: LexicalNode): boolean {
	let plain = $isParagraphNode(block) || $isHeadingNode(block) || $isQuoteNode(block)
		|| $isListItemNode(block) || $isCodeBlockNode(block);
	if (!plain || !$isElementNode(block)) return false;
	return !block.getChildren().some(function holds(child): boolean {
		return $isDecoratorNode(child) || ($isElementNode(child) && child.getChildren().some(holds));
	});
}

/** Put a copy of a block after it, with the caret at the copy's end. */
export function $duplicateBlock(block: LexicalNode): boolean {
	if (!$copyable(block)) return false;
	let copy = $parseSerializedNode(serialize(block));
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

export function registerBlockKeys(editor: LexicalEditor): () => void {
	let apple = isApplePlatform();
	return editor.registerCommand(
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
}

export function BlockKeysPlugin() {
	let [editor] = useLexicalComposerContext();
	useEffect(() => registerBlockKeys(editor), [editor]);
	return null;
}
