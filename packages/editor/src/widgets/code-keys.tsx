/**
 * The keys at a code block's edges, as Notion has them.
 *
 * Inside, a code block is a code editor: Enter is a line (`enter.tsx`) and Tab indents
 * (`tab-key.tsx`). At its edges it is a block of the document: Escape and Mod+Enter leave it for
 * the block after it, as do ArrowDown on its last line and ArrowRight at its very end where
 * nothing follows it to arrow into; Mod+A selects its code before the whole document; Backspace
 * in an empty one makes it a paragraph again; and ``` with a language's name, then Enter or
 * Space, at the start of an empty paragraph makes one. A paste into one is its text exactly:
 * Lexical's own paste makes each line a paragraph, which a code block cannot hold, and so lost
 * every line break.
 *
 * Registered low, beneath every handler that already claims these keys for something more
 * particular: a diagram's preview, a table's cells, a comment's card. Backspace in an empty block
 * is the exception, as nothing else has a claim on it.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createParagraphNode,
	$getSelection,
	$isElementNode,
	$isParagraphNode,
	$isRangeSelection,
	$isRootNode,
	COMMAND_PRIORITY_CRITICAL,
	COMMAND_PRIORITY_LOW,
	KEY_ARROW_DOWN_COMMAND,
	KEY_ARROW_RIGHT_COMMAND,
	KEY_BACKSPACE_COMMAND,
	KEY_ENTER_COMMAND,
	KEY_ESCAPE_COMMAND,
	KEY_SPACE_COMMAND,
	mergeRegister,
	PASTE_COMMAND,
	SELECT_ALL_COMMAND,
} from "lexical";
import { $createCodeBlockNode, $isCalloutNode, $isCodeBlockNode } from "@chopin/dialect";

import type { CodeBlockNode } from "@chopin/dialect";
import type { LexicalNode } from "lexical";

/** The language a typed fence names (`""` for none), or nothing for text that is not a fence. */
export function fenceOf(text: string): string | undefined {
	let found = /^```([\w#+.-]*)$/.exec(text);
	return found ? found[1]!.toLowerCase() : undefined;
}

/** The code block holding the whole selection, if one does. */
export function $selectedCode(): CodeBlockNode | undefined {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return undefined;
	let code = (node: LexicalNode) => {
		for (let at: LexicalNode | null = node; at; at = at.getParent()) {
			if ($isCodeBlockNode(at)) return at;
		}
		return undefined;
	};
	let anchor = code(selection.anchor.getNode());
	return anchor && anchor === code(selection.focus.getNode()) ? anchor : undefined;
}

/** The caret's offset in a code block's text, or nothing for a selection. */
function $caretOffset(code: CodeBlockNode): number | undefined {
	let selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return undefined;
	let point = selection.anchor;
	let node = point.getNode();
	let offset = 0;
	let index = point.type === "element" && node.is(code)
		? point.offset
		: code.getChildren().findIndex(child => child.is(node) || child.isParentOf(node));
	for (let child of code.getChildren().slice(0, Math.max(index, 0))) {
		offset += child.getTextContentSize();
	}
	return point.type === "text" ? offset + point.offset : offset;
}

/** Whether nothing in the document comes after a block, at its own level or any above it. */
function $last(node: LexicalNode): boolean {
	for (let at: LexicalNode | null = node; at && !$isRootNode(at); at = at.getParent()) {
		if (at.getNextSibling()) return false;
	}
	return true;
}

/** Put the caret at the start of the block after a code block, making a paragraph if none is. */
export function $leaveCode(code: CodeBlockNode): void {
	let next = code.getNextSibling();
	if ($isElementNode(next) && !next.isInline()) {
		next.selectStart();
		return;
	}
	let paragraph = $createParagraphNode();
	code.insertAfter(paragraph);
	paragraph.select();
}

export function CodeKeysPlugin() {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		let leave = (event: KeyboardEvent | null) => {
			let code = $selectedCode();
			if (!code) return false;
			event?.preventDefault();
			$leaveCode(code);
			return true;
		};

		/** ArrowDown on the last line, ArrowRight at the very end, where nothing follows to go to. */
		let past = (event: KeyboardEvent, right: boolean) => {
			if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
			let code = $selectedCode();
			if (!code || !$last(code)) return false;
			let offset = $caretOffset(code);
			let text = code.getTextContent();
			if (offset === undefined) return false;
			if (right ? offset !== text.length : text.includes("\n", offset)) return false;
			return leave(event);
		};

		/** A paragraph that holds only a typed fence becomes a code block in that language. */
		let fence = (event: KeyboardEvent | null) => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
			let node = selection.anchor.getNode();
			let paragraph = $isParagraphNode(node) ? node : node.getParent();
			if (!$isParagraphNode(paragraph)) return false;
			// Where a block may hold a code block: not a list item's line or a table's cell.
			let parent = paragraph.getParent();
			if (!$isRootNode(parent) && !$isCalloutNode(parent)) return false;
			let text = paragraph.getTextContent();
			let language = fenceOf(text);
			if (language === undefined || selection.anchor.offset !== text.length) return false;
			event?.preventDefault();
			let code = $createCodeBlockNode(language);
			paragraph.replace(code);
			code.select();
			return true;
		};

		return mergeRegister(
			editor.registerCommand(KEY_ESCAPE_COMMAND, leave, COMMAND_PRIORITY_LOW),
			editor.registerCommand(
				KEY_ENTER_COMMAND,
				event => {
					if (event && (event.metaKey || event.ctrlKey) && !event.shiftKey) return leave(event);
					if (event && (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey)) {
						return false;
					}
					return fence(event);
				},
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(KEY_SPACE_COMMAND, fence, COMMAND_PRIORITY_LOW),
			editor.registerCommand(
				PASTE_COMMAND,
				event => {
					if (!(event instanceof ClipboardEvent) || !$selectedCode()) return false;
					let text = event.clipboardData?.getData("text/plain");
					let selection = $getSelection();
					if (!text || !$isRangeSelection(selection)) return false;
					event.preventDefault();
					selection.insertRawText(text.replace(/\r\n?/g, "\n"));
					return true;
				},
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(
				KEY_ARROW_DOWN_COMMAND,
				event => past(event, false),
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(
				KEY_ARROW_RIGHT_COMMAND,
				event => past(event, true),
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(
				SELECT_ALL_COMMAND,
				event => {
					let code = $selectedCode();
					let selection = $getSelection();
					if (!code || !$isRangeSelection(selection)) return false;
					// The second press is the document's.
					if (selection.getTextContent() === code.getTextContent()) return false;
					event?.preventDefault();
					code.select(0, code.getChildrenSize());
					return true;
				},
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(
				KEY_BACKSPACE_COMMAND,
				event => {
					let code = $selectedCode();
					let selection = $getSelection();
					if (!code || !$isRangeSelection(selection) || !selection.isCollapsed()) return false;
					if (code.getTextContent() !== "") return false;
					event.preventDefault();
					let paragraph = $createParagraphNode();
					code.replace(paragraph);
					paragraph.select();
					return true;
				},
				// Ahead of the title's guard, which keeps Backspace from merging a block into the
				// title: an empty code block straight under it is still turned back, not merged.
				COMMAND_PRIORITY_CRITICAL,
			),
		);
	}, [editor]);

	return null;
}
