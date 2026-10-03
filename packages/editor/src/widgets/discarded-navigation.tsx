/** Leave a discarded block out of horizontal prose navigation. */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCellValue } from "@mdxeditor/gurx";
import {
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isRootNode,
	$isTextNode,
	COMMAND_PRIORITY_HIGH,
	KEY_ARROW_LEFT_COMMAND,
	KEY_ARROW_RIGHT_COMMAND,
} from "lexical";
import { $isQuestionnaireNode, cardStatus } from "@chopin/dialect";

import { atBlockEnd, atBlockStart } from "./discarded-navigation-boundary";
import { widgets$ } from "../widget-options";

import type { LexicalNode } from "lexical";
import type { ElementNode } from "lexical";
import type { CardMetaStore } from "../card-meta";

type PreviousBoundary = { crossed: boolean; target?: LexicalNode };

function isDiscarded(node: LexicalNode | null | undefined, cardMeta: CardMetaStore | undefined) {
	return $isQuestionnaireNode(node)
		&& (cardMeta?.get(node.getId())?.status ?? cardStatus(node.getQuestionnaire())) === "discarded";
}

function lastEditable(node: LexicalNode | null | undefined): LexicalNode | undefined {
	if (!node) return undefined;
	if ($isTextNode(node)) return node;
	if (!$isElementNode(node)) return undefined;
	let children = node.getChildren();
	for (let index = children.length - 1; index >= 0; index--) {
		let text = lastEditable(children[index]);
		if (text) return text;
	}
	return node;
}

function firstEditable(node: LexicalNode | null | undefined): LexicalNode | undefined {
	if (!node) return undefined;
	if ($isTextNode(node)) return node;
	if (!$isElementNode(node)) return undefined;
	for (let child of node.getChildren()) {
		let text = firstEditable(child);
		if (text) return text;
	}
	return node;
}

function previousTextFromBlock(block: LexicalNode, cardMeta: CardMetaStore | undefined) {
	let sibling = block.getPreviousSibling();
	if (!isDiscarded(sibling, cardMeta)) return { crossed: false };
	while (sibling && isDiscarded(sibling, cardMeta)) sibling = sibling.getPreviousSibling();
	return { crossed: true, target: lastEditable(sibling) };
}

function previousTextFromPoint(
	parent: ElementNode,
	offset: number,
	cardMeta: CardMetaStore | undefined,
) {
	let left = parent.getChildAtIndex(offset - 1);
	let right = parent.getChildAtIndex(offset);
	if (isDiscarded(left, cardMeta)) {
		while (left && isDiscarded(left, cardMeta)) left = left.getPreviousSibling();
		return { crossed: true, target: lastEditable(left) };
	}
	if (isDiscarded(right, cardMeta)) {
		return { crossed: true, target: lastEditable(left) };
	}
	return { crossed: false };
}

function unmodified(event: KeyboardEvent) {
	return !event.defaultPrevented && !event.shiftKey && !event.altKey && !event.ctrlKey
		&& !event.metaKey;
}

function leaveDiscardedBehind(event: KeyboardEvent, cardMeta: CardMetaStore | undefined): boolean {
	if (!unmodified(event)) return false;
	let selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
	let anchor = selection.anchor;
	let boundary: PreviousBoundary = { crossed: false };
	if (anchor.type === "text" && anchor.offset === 0 && atBlockStart(anchor.getNode())) {
		let block: LexicalNode = anchor.getNode();
		let parent = block.getParent();
		while (parent && !$isRootNode(parent)) {
			block = parent;
			parent = block.getParent();
		}
		boundary = previousTextFromBlock(block, cardMeta);
	} else if (anchor.type === "element") {
		let parent = anchor.getNode();
		if ($isElementNode(parent)) {
			boundary = previousTextFromPoint(parent, anchor.offset, cardMeta);
		}
	}
	if (!boundary.crossed) return false;
	boundary.target?.selectEnd();
	event.preventDefault();
	return true;
}

function skipDiscardedOnRight(event: KeyboardEvent, cardMeta: CardMetaStore | undefined) {
	if (!unmodified(event)) return false;
	let selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
	let anchor = selection.anchor;
	if (
		anchor.type !== "text"
		|| anchor.offset !== anchor.getNode().getTextContentSize()
		|| !atBlockEnd(anchor.getNode())
	) return false;
	let block: LexicalNode = anchor.getNode();
	let parent = block.getParent();
	while (parent && !$isRootNode(parent)) {
		block = parent;
		parent = block.getParent();
	}
	let sibling = block.getNextSibling();
	if (!isDiscarded(sibling, cardMeta)) return false;
	while (sibling && isDiscarded(sibling, cardMeta)) sibling = sibling.getNextSibling();
	if (sibling) {
		let target = firstEditable(sibling);
		if (!target) return false;
		target.selectStart();
	}
	event.preventDefault();
	return true;
}

export function DiscardedNavigationPlugin() {
	let [editor] = useLexicalComposerContext();
	let { cardMeta } = useCellValue(widgets$);
	useEffect(() => {
		let off = [
			editor.registerCommand(
				KEY_ARROW_LEFT_COMMAND,
				event => leaveDiscardedBehind(event, cardMeta),
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ARROW_RIGHT_COMMAND,
				event => skipDiscardedOnRight(event, cardMeta),
				COMMAND_PRIORITY_HIGH,
			),
		];
		return () => off.forEach(dispose => dispose());
	}, [editor, cardMeta]);
	return null;
}
