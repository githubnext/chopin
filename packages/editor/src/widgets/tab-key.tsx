/**
 * What the Tab key does inside the document.
 *
 * MDXEditor's lists plugin installs Lexical's tab indentation for every block,
 * not only lists. Tab then never leaves the editor, so a keyboard user cannot
 * get past it, and every attempt edits the shared document: headings and
 * paragraphs gain an indent that MDX cannot even express, and text gains
 * literal tab characters.
 *
 * Registered above that handler and below `@lexical/table`'s, which already
 * moves between cells. A list item nests and un-nests from anywhere in its
 * text; a code block takes a tab character; everywhere else the browser keeps
 * the key and moves focus.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isListItemNode } from "@lexical/list";
import {
	$getSelection,
	$isRangeSelection,
	COMMAND_PRIORITY_LOW,
	INDENT_CONTENT_COMMAND,
	INSERT_TAB_COMMAND,
	KEY_TAB_COMMAND,
	OUTDENT_CONTENT_COMMAND,
} from "lexical";
import { $isCodeBlockNode } from "@chopin/dialect";

import type { LexicalNode, PointType } from "lexical";

/** Where the selection sits, as far as Tab is concerned. */
export type TabPlace = "list" | "code" | "prose";

/** What a Tab keystroke should do. `leave` hands the key back to the browser. */
export type TabAction = "indent" | "outdent" | "tab" | "leave";

export function tabAction(place: TabPlace, shift: boolean): TabAction {
	if (place === "list") return shift ? "outdent" : "indent";
	if (place === "code" && !shift) return "tab";
	return "leave";
}

function $placeOf(point: PointType): TabPlace {
	for (let node: LexicalNode | null = point.getNode(); node; node = node.getParent()) {
		if ($isCodeBlockNode(node)) return "code";
		if ($isListItemNode(node)) return "list";
	}
	return "prose";
}

/** Both ends have to agree; a selection spanning a list and a paragraph is prose. */
export function $tabPlace(): TabPlace | null {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return null;
	let anchor = $placeOf(selection.anchor);
	return anchor === $placeOf(selection.focus) ? anchor : "prose";
}

export function TabKeyPlugin() {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		return editor.registerCommand(
			KEY_TAB_COMMAND,
			event => {
				let place = $tabPlace();
				if (place === null) return false;
				let action = tabAction(place, event.shiftKey);
				// Handled without preventing the default, so Lexical's own
				// indentation never runs and the browser moves focus.
				if (action === "leave") return true;
				event.preventDefault();
				let command = action === "indent"
					? INDENT_CONTENT_COMMAND
					: action === "outdent"
					? OUTDENT_CONTENT_COMMAND
					: INSERT_TAB_COMMAND;
				editor.dispatchCommand(command, undefined);
				return true;
			},
			COMMAND_PRIORITY_LOW,
		);
	}, [editor]);

	return null;
}
