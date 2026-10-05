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
 * text, but only where that is a real change; a code block indents and
 * outdents its lines; everywhere else the browser keeps the key and moves
 * focus.
 *
 * Inside a code block Tab belongs to the code, so the way out is Escape then
 * Tab, as in CodeMirror. Escape there arms the next Tab rather than blurring:
 * Chrome forgets where focus was when an element blurs, and Tab from nowhere
 * starts again at the top of the page.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getListDepth, $isListItemNode, $isListNode } from "@lexical/list";
import {
	$getSelection,
	$isRangeSelection,
	$isTabNode,
	$isTextNode,
	COMMAND_PRIORITY_LOW,
	INDENT_CONTENT_COMMAND,
	INSERT_TAB_COMMAND,
	KEY_DOWN_COMMAND,
	KEY_ESCAPE_COMMAND,
	KEY_TAB_COMMAND,
	mergeRegister,
	OUTDENT_CONTENT_COMMAND,
} from "lexical";
import { $isCodeBlockNode } from "@chopin/dialect";

import type { ListItemNode } from "@lexical/list";
import type { ElementNode, LexicalNode, PointType, RangeSelection } from "lexical";
import type { CodeBlockNode } from "@chopin/dialect";

/** Where the selection sits, as far as Tab is concerned. */
export type TabContext =
	| { place: "prose" }
	| { place: "code" }
	| { place: "list"; nest: boolean; unnest: boolean };

/** What a Tab keystroke should do. `leave` hands the key back to the browser. */
export type TabAction = "indent" | "outdent" | "tab" | "untab" | "leave";

/** `escaped` is whether Escape was the key pressed just before this one. */
export function tabAction(context: TabContext, shift: boolean, escaped = false): TabAction {
	if (context.place === "code") {
		if (escaped) return "leave";
		return shift ? "untab" : "tab";
	}
	if (context.place === "list") {
		// Lexical would still "indent" an item with nothing to nest under, by
		// wrapping it in an empty item everyone else sees. A key that cannot
		// change the list moves focus instead.
		if (shift) return context.unnest ? "outdent" : "leave";
		return context.nest ? "indent" : "leave";
	}
	return "leave";
}

/** The deepest list the lists plugin lets an item be indented from. */
const MAX_DEPTH = 7;

function $placeOf(node: LexicalNode): "list" | "code" | "prose" {
	for (let at: LexicalNode | null = node; at; at = at.getParent()) {
		if ($isCodeBlockNode(at)) return "code";
		if ($isListItemNode(at) || $isListNode(at)) return "list";
	}
	return "prose";
}

/** The item holding a node's text, skipping items that only wrap a nested list. */
function $itemOf(node: LexicalNode): ListItemNode | null {
	for (let at: LexicalNode | null = node; at; at = at.getParent()) {
		if ($isListItemNode(at)) {
			return at.getChildren().every($isListNode) ? null : at;
		}
	}
	return null;
}

function $canNest(item: ListItemNode): boolean {
	let list = item.getParent();
	return $isListItemNode(item.getPreviousSibling())
		&& $isListNode(list)
		&& $getListDepth(list) + 1 <= MAX_DEPTH;
}

function $canUnnest(item: ListItemNode): boolean {
	return $isListItemNode(item.getParent()?.getParent());
}

/** Every selected block has to agree; a selection from a list into a paragraph is prose. */
export function $tabContext(): TabContext | null {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return null;
	let nodes = [selection.anchor.getNode(), selection.focus.getNode(), ...selection.getNodes()];
	let place = $placeOf(nodes[0]!);
	if (nodes.some(node => $placeOf(node) !== place)) return { place: "prose" };
	if (place !== "list") return { place };

	let items = new Set<ListItemNode>();
	for (let node of nodes) {
		let item = $itemOf(node);
		if (item) items.add(item);
	}
	let all = [...items];
	return {
		place,
		nest: all.length > 0 && all.every($canNest),
		unnest: all.length > 0 && all.every($canUnnest),
	};
}

/** The indent opening the line that holds `offset`: one tab, or up to four spaces. */
export function leadingIndent(
	text: string,
	offset: number,
): { start: number; length: number } | null {
	let start = text.lastIndexOf("\n", offset - 1) + 1;
	if (text[start] === "\t") return { start, length: 1 };
	let length = 0;
	while (length < 4 && text[start + length] === " ") length++;
	return length > 0 ? { start, length } : null;
}

function $offsetOf(code: ElementNode, point: PointType): number {
	let children = code.getChildren();
	let node = point.getNode();
	let index = point.type === "element" && node.is(code)
		? point.offset
		: children.findIndex(child => child.is(node));
	let offset = 0;
	for (let child of children.slice(0, Math.max(index, 0))) offset += child.getTextContentSize();
	return point.type === "text" ? offset + point.offset : offset;
}

function $setPoint(code: ElementNode, point: PointType, offset: number): void {
	let start = 0;
	let children = code.getChildren();
	for (let [index, child] of children.entries()) {
		let size = child.getTextContentSize();
		if ($isTextNode(child) && offset <= start + size) {
			point.set(child.getKey(), offset - start, "text");
			return;
		}
		if (offset <= start) {
			point.set(code.getKey(), index, "element");
			return;
		}
		start += size;
	}
	point.set(code.getKey(), children.length, "element");
}

/** Remove one level of indent from the line holding the caret. */
export function $untab(code: CodeBlockNode, selection: RangeSelection): void {
	let anchor = $offsetOf(code, selection.anchor);
	let focus = $offsetOf(code, selection.focus);
	let indent = leadingIndent(code.getTextContent(), anchor);
	if (!indent) return;

	let start = 0;
	let removed = 0;
	for (let child of code.getChildren()) {
		let size = child.getTextContentSize();
		if (indent.start >= start && indent.start < start + size) {
			if ($isTabNode(child)) {
				child.remove();
				removed = 1;
			} else if ($isTextNode(child)) {
				removed = Math.min(indent.length, start + size - indent.start);
				child.spliceText(indent.start - start, removed, "");
			}
			break;
		}
		start += size;
	}
	if (!removed) return;

	let shift = (offset: number) =>
		offset <= indent.start ? offset : Math.max(indent.start, offset - removed);
	$setPoint(code, selection.anchor, shift(anchor));
	$setPoint(code, selection.focus, shift(focus));
}

function $enclosingCode(selection: RangeSelection): CodeBlockNode | null {
	for (let at: LexicalNode | null = selection.anchor.getNode(); at; at = at.getParent()) {
		if ($isCodeBlockNode(at)) return at;
	}
	return null;
}

export function TabKeyPlugin() {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		let escaped = false;
		return mergeRegister(
			editor.registerCommand(
				KEY_DOWN_COMMAND,
				event => {
					if (event.key !== "Escape" && event.key !== "Tab") escaped = false;
					return false;
				},
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(
				KEY_ESCAPE_COMMAND,
				() => {
					if ($tabContext()?.place !== "code") return false;
					escaped = true;
					return true;
				},
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(
				KEY_TAB_COMMAND,
				event => {
					let context = $tabContext();
					if (context === null) return false;
					let action = tabAction(context, event.shiftKey, escaped);
					escaped = false;
					// Handled without preventing the default, so Lexical's own
					// indentation never runs and the browser moves focus.
					if (action === "leave") return true;
					event.preventDefault();
					if (action === "untab") {
						let selection = $getSelection();
						let code = $isRangeSelection(selection) ? $enclosingCode(selection) : null;
						if ($isRangeSelection(selection) && code) $untab(code, selection);
						return true;
					}
					let command = action === "indent"
						? INDENT_CONTENT_COMMAND
						: action === "outdent"
						? OUTDENT_CONTENT_COMMAND
						: INSERT_TAB_COMMAND;
					editor.dispatchCommand(command, undefined);
					return true;
				},
				COMMAND_PRIORITY_LOW,
			),
		);
	}, [editor]);

	return null;
}
