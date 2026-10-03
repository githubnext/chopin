import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCellValue } from "@mdxeditor/gurx";
import {
	$getRoot,
	$getSelection,
	$isParagraphNode,
	$isRangeSelection,
	COMMAND_PRIORITY_LOW,
	RootNode,
	SELECTION_CHANGE_COMMAND,
} from "lexical";
import { $isDecisionNode, $isQuestionnaireNode } from "@chopin/dialect";

import { widgets$ } from "../widget-options";

import type { LexicalNode } from "lexical";

function card(node: LexicalNode | null | undefined): boolean {
	return $isQuestionnaireNode(node) || $isDecisionNode(node);
}

function empty(node: LexicalNode | null | undefined): boolean {
	return $isParagraphNode(node) && node.getChildrenSize() === 0;
}

/** True when a local selection kept a run for a later selection change. */
export function compactCardGaps(): boolean {
	let children = $getRoot().getChildren();
	let selection = $getSelection();
	if ($isRangeSelection(selection) && !selection.isCollapsed()) return true;
	let caret = $isRangeSelection(selection) && selection.isCollapsed()
		? selection.anchor.getNode()
		: undefined;
	let deferred = false;
	for (let index = 0; index < children.length; index++) {
		if (!card(children[index])) continue;
		let end = index + 1;
		while (empty(children[end])) end++;
		if (end - index > 2 && card(children[end])) {
			let blanks = children.slice(index + 1, end);
			// Keep the current caret's paragraph until the author leaves it.
			if (caret && blanks.includes(caret)) deferred = true;
			else for (let blank of blanks.slice(1)) blank.remove();
		}
		index = end - 1;
	}
	return deferred;
}

export function CardGapPlugin() {
	let [editor] = useLexicalComposerContext();
	let { canEdit, connected, synced } = useCellValue(widgets$);

	useEffect(() => {
		if (!canEdit || !connected || !synced) return;
		let deferred = false;
		let normalize = () => deferred = compactCardGaps();
		let stopTransform = editor.registerNodeTransform(RootNode, normalize);
		let stopSelection = editor.registerCommand(
			SELECTION_CHANGE_COMMAND,
			() => {
				if (deferred) normalize();
				return false;
			},
			COMMAND_PRIORITY_LOW,
		);
		editor.update(normalize);
		return () => {
			stopSelection();
			stopTransform();
		};
	}, [editor, canEdit, connected, synced]);

	return null;
}
