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
 * outdents its lines, every line a selection touches; everywhere else the
 * browser keeps the key and moves focus.
 *
 * Inside a code block Tab belongs to the code, so the way out is Escape, which
 * puts the caret in the block after it (`code-keys.tsx`), and Tab from there.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getListDepth, $isListItemNode, $isListNode } from "@lexical/list";
import {
	$createTabNode,
	$getSelection,
	$isRangeSelection,
	$isTabNode,
	$isTextNode,
	COMMAND_PRIORITY_LOW,
	INDENT_CONTENT_COMMAND,
	INSERT_TAB_COMMAND,
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

export function tabAction(context: TabContext, shift: boolean): TabAction {
	if (context.place === "code") return shift ? "untab" : "tab";
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

/**
 * Where the lines between two offsets start, first to last. A selection that ends at the start of
 * a line leaves that line alone, as a code editor does: it selected the line before, whole.
 */
export function lineStarts(text: string, from: number, to: number): number[] {
	let [low, high] = from <= to ? [from, to] : [to, from];
	let starts = [text.lastIndexOf("\n", low - 1) + 1];
	for (
		let at = text.indexOf("\n", low);
		at !== -1 && at + 1 < high;
		at = text.indexOf("\n", at + 1)
	) {
		starts.push(at + 1);
	}
	return starts;
}

/** Remove up to `length` characters of indent at `start`; returns how many went. */
function $removeIndent(code: CodeBlockNode, start: number, length: number): number {
	let at = 0;
	for (let child of code.getChildren()) {
		let size = child.getTextContentSize();
		if (start >= at && start < at + size) {
			if ($isTabNode(child)) {
				child.remove();
				return 1;
			}
			if (!$isTextNode(child)) return 0;
			let removed = Math.min(length, at + size - start);
			child.spliceText(start - at, removed, "");
			return removed;
		}
		at += size;
	}
	return 0;
}

/** Put a tab at `offset`, as the Tab key does at a caret: a tab node of its own. */
function $insertTab(code: CodeBlockNode, offset: number): void {
	let at = 0;
	for (let child of code.getChildren()) {
		let size = child.getTextContentSize();
		if (offset <= at) {
			child.insertBefore($createTabNode());
			return;
		}
		if ($isTextNode(child) && !$isTabNode(child) && offset < at + size) {
			let [, after] = child.splitText(offset - at);
			after!.insertBefore($createTabNode());
			return;
		}
		at += size;
	}
	code.append($createTabNode());
}

/** Indent every line the selection touches by one tab, keeping those lines selected. */
export function $indentLines(code: CodeBlockNode, selection: RangeSelection): void {
	let anchor = $offsetOf(code, selection.anchor);
	let focus = $offsetOf(code, selection.focus);
	let starts = lineStarts(code.getTextContent(), anchor, focus);
	for (let start of starts.toReversed()) $insertTab(code, start);
	// A point at a line's start stays before the new tab, so the line is still selected whole.
	let shift = (offset: number) => offset + starts.filter(start => start < offset).length;
	$setPoint(code, selection.anchor, shift(anchor));
	$setPoint(code, selection.focus, shift(focus));
}

/** Remove one level of indent from every line the selection touches, or the caret's line. */
export function $untab(code: CodeBlockNode, selection: RangeSelection): void {
	let anchor = $offsetOf(code, selection.anchor);
	let focus = $offsetOf(code, selection.focus);
	let text = code.getTextContent();
	let removed: { start: number; length: number }[] = [];
	for (let start of lineStarts(text, anchor, focus).toReversed()) {
		let indent = leadingIndent(text, start);
		if (!indent) continue;
		let length = $removeIndent(code, indent.start, indent.length);
		if (length) removed.push({ start: indent.start, length });
	}
	if (!removed.length) return;

	let shift = (offset: number) =>
		offset - removed.reduce(
			(sum, { start, length }) => sum + Math.max(0, Math.min(length, offset - start)),
			0,
		);
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
		return mergeRegister(
			editor.registerCommand(
				KEY_TAB_COMMAND,
				event => {
					let context = $tabContext();
					if (context === null) return false;
					let action = tabAction(context, event.shiftKey);
					// Handled without preventing the default, so Lexical's own
					// indentation never runs and the browser moves focus.
					if (action === "leave") return true;
					event.preventDefault();
					let selection = $getSelection();
					let code = $isRangeSelection(selection) ? $enclosingCode(selection) : null;
					if (action === "untab") {
						if ($isRangeSelection(selection) && code) $untab(code, selection);
						return true;
					}
					if (
						action === "tab" && $isRangeSelection(selection) && code && !selection.isCollapsed()
					) {
						$indentLines(code, selection);
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
