/** Keep an answered card's hidden document node out of ordinary text deletion. */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCellValue } from "@mdxeditor/gurx";
import {
	$getNearestNodeFromDOMNode,
	$getSelection,
	$isElementNode,
	$isNodeSelection,
	$isRangeSelection,
	$isRootNode,
	COMMAND_PRIORITY_HIGH,
	DELETE_CHARACTER_COMMAND,
	DELETE_LINE_COMMAND,
	DELETE_WORD_COMMAND,
	KEY_BACKSPACE_COMMAND,
	mergeRegister,
	REMOVE_TEXT_COMMAND,
} from "lexical";

import { $isQuestionnaireNode, cardStatus } from "@chopin/dialect";
import { widgets$ } from "../widget-options";
import { atBlockEnd, atBlockStart } from "./discarded-navigation-boundary";

import type { LexicalEditor, LexicalNode, RangeSelection } from "lexical";
import type { CardMetaStore } from "../card-meta";
import type { QuestionnaireStore } from "../questionnaires";

function decided(node: LexicalNode | null, meta: CardMetaStore | undefined): boolean {
	return $isQuestionnaireNode(node)
		&& (meta?.get(node.getId())?.status ?? cardStatus(node.getQuestionnaire())) === "decided";
}

function topLevel(node: LexicalNode): LexicalNode {
	let block = node;
	while (block.getParent() && !$isRootNode(block.getParent())) block = block.getParent()!;
	return block;
}

function boundary(selection: RangeSelection, backward: boolean): LexicalNode | null {
	let point = selection.anchor;
	let node = point.getNode();
	if ($isRootNode(node)) {
		return node.getChildAtIndex(backward ? point.offset - 1 : point.offset);
	}
	if (point.type === "text") {
		if (
			backward
				? point.offset !== 0 || !atBlockStart(node)
				: point.offset !== node.getTextContentSize() || !atBlockEnd(node)
		) return null;
	} else if ($isElementNode(node)) {
		if (
			backward
				? point.offset !== 0 || !atBlockStart(node)
				: point.offset !== node.getChildrenSize() || !atBlockEnd(node)
		) return null;
	} else return null;
	let block = topLevel(node);
	return backward ? block.getPreviousSibling() : block.getNextSibling();
}

function browserBoundary(editor: LexicalEditor): LexicalNode | null {
	if (typeof window === "undefined") return null;
	let selection = window.getSelection();
	let anchor = selection?.anchorNode;
	if (!selection?.isCollapsed || !anchor || selection.anchorOffset !== 0) return null;
	if (!editor.getRootElement()?.contains(anchor)) return null;
	let node = $getNearestNodeFromDOMNode(anchor);
	if (!node || !atBlockStart(node)) return null;
	return topLevel(node).getPreviousSibling();
}

function moveIntoProse(card: LexicalNode, questions: QuestionnaireStore | undefined): void {
	if (!$isQuestionnaireNode(card)) return;
	let previous = card.getPreviousSibling();
	if (previous && previous.getKey() === questions?.proseKey(card.getId())) {
		previous.selectEnd();
	}
}

function protect(
	backward: boolean | undefined,
	meta: CardMetaStore | undefined,
	questions: QuestionnaireStore | undefined,
): boolean {
	let selection = $getSelection();
	if ($isNodeSelection(selection)) return selection.getNodes().some(node => decided(node, meta));
	if (!$isRangeSelection(selection)) return false;
	if (!selection.isCollapsed()) return selection.getNodes().some(node => decided(node, meta));
	if (backward === undefined) return false;
	let card = boundary(selection, backward);
	if (!decided(card, meta)) return false;
	if (backward) moveIntoProse(card!, questions);
	return true;
}

export function registerDecisionDeletion(
	editor: LexicalEditor,
	meta: CardMetaStore | undefined,
	questions: QuestionnaireStore | undefined,
): () => void {
	return mergeRegister(
		editor.registerCommand(
			KEY_BACKSPACE_COMMAND,
			event => {
				let card = browserBoundary(editor);
				if (!decided(card, meta)) return false;
				moveIntoProse(card!, questions);
				event.preventDefault();
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		),
		editor.registerCommand(
			DELETE_CHARACTER_COMMAND,
			backward => protect(backward, meta, questions),
			COMMAND_PRIORITY_HIGH,
		),
		editor.registerCommand(
			DELETE_WORD_COMMAND,
			backward => protect(backward, meta, questions),
			COMMAND_PRIORITY_HIGH,
		),
		editor.registerCommand(
			DELETE_LINE_COMMAND,
			backward => protect(backward, meta, questions),
			COMMAND_PRIORITY_HIGH,
		),
		editor.registerCommand(
			REMOVE_TEXT_COMMAND,
			() => protect(undefined, meta, questions),
			COMMAND_PRIORITY_HIGH,
		),
	);
}

export function DecisionDeletionPlugin() {
	let [editor] = useLexicalComposerContext();
	let { cardMeta, questions } = useCellValue(widgets$);
	useEffect(() => registerDecisionDeletion(editor, cardMeta, questions), [
		editor,
		cardMeta,
		questions,
	]);
	return null;
}
