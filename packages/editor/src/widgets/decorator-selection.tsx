/**
 * Keeping the caret, and the keyboard, away from decorators that cannot take
 * them.
 *
 * Arrowing onto a decorator block gives Lexical a node selection, and Lexical
 * then declines to handle `beforeinput` for it without cancelling the event.
 * The browser has no text caret to insert at, so it writes into the root at
 * its start, and because the editor's own selection never moves, every further
 * character goes in front of the last: typing "abc" gives "cba" at the top of
 * the document. `BEFORE_INPUT_COMMAND` therefore cancels insertion while a node
 * is selected.
 *
 * A resolved decision that a margin marker carries renders as a hidden
 * placeholder. Selecting it is invisible, so ArrowUp, ArrowDown, ArrowLeft and
 * ArrowRight step over it to the next block of text instead, as if it were not
 * there. Backspace and Delete next to it are still Lexical's.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createNodeSelection,
	$getRoot,
	$getSelection,
	$isDecoratorNode,
	$isElementNode,
	$isNodeSelection,
	$isParagraphNode,
	$isRangeSelection,
	$isRootNode,
	$isTextNode,
	$setSelection,
	BEFORE_INPUT_COMMAND,
	COMMAND_PRIORITY_HIGH,
	KEY_ARROW_DOWN_COMMAND,
	KEY_ARROW_LEFT_COMMAND,
	KEY_ARROW_RIGHT_COMMAND,
	KEY_ARROW_UP_COMMAND,
	KEY_BACKSPACE_COMMAND,
	KEY_DELETE_COMMAND,
	mergeRegister,
} from "lexical";

import type {
	ElementNode,
	LexicalCommand,
	LexicalEditor,
	LexicalNode,
	RangeSelection,
} from "lexical";

type Direction = "next" | "previous";

/**
 * Where an arrow key from beside a run of hidden blocks ends up.
 *
 * `blocks` are the siblings in document order; the hidden ones are skipped. A
 * visible block of text takes the caret, any other visible block is selected
 * like Lexical would, and running out of siblings leaves the key to Lexical.
 */
export function skip<T>(
	blocks: readonly T[],
	from: number,
	direction: Direction,
	hidden: (block: T) => boolean,
): { at: number } | undefined {
	let step = direction === "next" ? 1 : -1;
	let at = from + step;
	if (blocks[at] === undefined || !hidden(blocks[at]!)) return undefined;
	while (blocks[at] !== undefined && hidden(blocks[at]!)) at += step;
	return blocks[at] === undefined ? undefined : { at };
}

/** Whether the caret has nowhere further to go inside its block. */
function $atEdge(selection: RangeSelection, block: ElementNode, direction: Direction): boolean {
	let { key, offset, type } = selection.focus;
	let node = selection.focus.getNode();
	if (type === "text" && $isTextNode(node)) {
		let end = direction === "next" ? offset === node.getTextContentSize() : offset === 0;
		let last = direction === "next" ? block.getLastDescendant() : block.getFirstDescendant();
		return end && (last === null || last.getKey() === key);
	}
	if (!$isElementNode(node)) return false;
	if (direction === "previous") return offset === 0 && (node.is(block) || node.isEmpty());
	return offset === node.getChildrenSize() && (node.is(block) || node.isEmpty());
}

type Hidden = (key: string) => boolean;

function $isHiddenBlock(node: LexicalNode, hidden: Hidden): boolean {
	return $isDecoratorNode(node) && !node.isInline() && hidden(node.getKey());
}

/**
 * The hidden blocks beside a collapsed caret, and the visible block past them.
 *
 * Without `vertical` the caret must also be at the edge of its block, since a
 * horizontal key only crosses a block boundary from there.
 */
function $across(direction: Direction, vertical: boolean, hidden: Hidden) {
	let selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return undefined;

	let focus = selection.focus.getNode();
	let root = $isRootNode(focus);
	let block = root ? null : focus.getTopLevelElement();
	if (!root && block === null) return undefined;

	let siblings: LexicalNode[] = $getRoot().getChildren();

	let from: number;
	if (root) {
		// The caret sits between root children; an offset `n` is before child `n`.
		let offset = selection.focus.offset;
		from = direction === "next" ? offset - 1 : offset;
	} else {
		if (!vertical && !$atEdge(selection, block!, direction)) return undefined;
		from = siblings.findIndex(sibling => sibling.is(block));
	}

	let target = skip(siblings, from, direction, node => $isHiddenBlock(node, hidden));
	if (!target) return undefined;
	return { block, landing: siblings[target.at]! };
}

/**
 * Step over the hidden blocks next to the caret, if there are any.
 *
 * Vertical movement is left to the browser, which keeps the caret's column and
 * has nothing to land on in a block that is not displayed; all that has to be
 * done is to stop Lexical selecting the block first. Horizontal movement has no
 * such fallback, so it places the caret itself. A visible decorator past the
 * hidden blocks is selected by `$releaseHidden` once Lexical has selected the
 * hidden one in front of it.
 */
export function $skipHidden(
	direction: Direction,
	vertical: boolean,
	hidden: Hidden,
): "native" | "moved" | undefined {
	let found = $across(direction, vertical, hidden);
	if (!found) return undefined;
	let { landing } = found;
	if ($isDecoratorNode(landing)) {
		if (vertical) return undefined;
		$selectOnly(landing);
		return "moved";
	}
	if (vertical) return "native";
	if ($isElementNode(landing)) {
		if (direction === "next") landing.selectStart();
		else landing.selectEnd();
		return "moved";
	}
	return undefined;
}

function $selectOnly(node: LexicalNode): void {
	let nodes = $createNodeSelection();
	nodes.add(node.getKey());
	$setSelection(nodes);
}

/**
 * Backspace or Delete beside a hidden block, as if it were not there.
 *
 * Lexical would select the placeholder, and a second press would delete a
 * decision nobody can see. Two paragraphs join around it; any other pair just
 * gets the caret, and the placeholder stays where it is.
 */
export function $deleteAcross(direction: Direction, hidden: Hidden): boolean {
	let found = $across(direction, false, hidden);
	if (!found?.block) return false;
	let { block, landing } = found;
	if (!$isElementNode(landing)) return false;

	if ($isParagraphNode(block) && $isParagraphNode(landing)) {
		if (direction === "previous") {
			// A text point, because an element offset would be read as the end of
			// the merged text once adjacent text nodes are normalised into one.
			let tail = landing.getLastDescendant();
			let end = landing.getChildrenSize();
			landing.append(...block.getChildren());
			block.remove();
			if ($isTextNode(tail)) tail.select(tail.getTextContentSize(), tail.getTextContentSize());
			else landing.select(end, end);
		} else {
			let tail = block.getLastDescendant();
			let end = block.getChildrenSize();
			block.append(...landing.getChildren());
			landing.remove();
			if ($isTextNode(tail)) tail.select(tail.getTextContentSize(), tail.getTextContentSize());
			else block.select(end, end);
		}
	} else if (direction === "previous") landing.selectEnd();
	else landing.selectStart();
	return true;
}

/**
 * Whatever put a hidden block in a node selection, take it back out.
 *
 * Moves on in the direction the last key was heading: to a visible decorator
 * if one is next, otherwise to text, and failing that back the other way.
 */
export function $releaseHidden(direction: Direction, hidden: Hidden): boolean {
	let selection = $getSelection();
	if (!$isNodeSelection(selection)) return false;
	let nodes = selection.getNodes();
	if (nodes.length === 0 || !nodes.every(node => $isHiddenBlock(node, hidden))) return false;

	let siblings: LexicalNode[] = $getRoot().getChildren();
	let edge = nodes.map(node => siblings.findIndex(sibling => sibling.is(node)));
	for (let way of [direction, direction === "next" ? "previous" : "next"] as Direction[]) {
		let step = way === "next" ? 1 : -1;
		let at = (way === "next" ? Math.max(...edge) : Math.min(...edge)) + step;
		while (siblings[at] && $isHiddenBlock(siblings[at]!, hidden)) at += step;
		let landing = siblings[at];
		if (!landing) continue;
		if ($isDecoratorNode(landing)) $selectOnly(landing);
		else if ($isElementNode(landing)) {
			if (way === "next") landing.selectStart();
			else landing.selectEnd();
		} else continue;
		return true;
	}
	return false;
}

export function registerDecoratorSelection(
	editor: LexicalEditor,
	hidden: Hidden = key => isHidden(editor, key),
): () => void {
	let heading: Direction = "next";
	let remove = (command: LexicalCommand<KeyboardEvent | null>, direction: Direction) =>
		editor.registerCommand(
			command,
			event => {
				heading = direction;
				if (event?.shiftKey || event?.altKey || event?.metaKey || event?.ctrlKey) return false;
				if (!$deleteAcross(direction, hidden)) return false;
				event?.preventDefault();
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		);
	let arrow = (command: LexicalCommand<KeyboardEvent>, direction: Direction, vertical: boolean) =>
		editor.registerCommand(
			command,
			event => {
				heading = direction;
				if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
				let outcome = $skipHidden(direction, vertical, hidden);
				if (outcome === undefined) return false;
				if (outcome === "moved") event.preventDefault();
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		);

	return mergeRegister(
		editor.registerCommand(
			BEFORE_INPUT_COMMAND,
			event => {
				if (!event.inputType.startsWith("insert") || !$isNodeSelection($getSelection())) {
					return false;
				}
				event.preventDefault();
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		),
		arrow(KEY_ARROW_UP_COMMAND, "previous", true),
		arrow(KEY_ARROW_DOWN_COMMAND, "next", true),
		arrow(KEY_ARROW_LEFT_COMMAND, "previous", false),
		arrow(KEY_ARROW_RIGHT_COMMAND, "next", false),
		remove(KEY_BACKSPACE_COMMAND, "previous"),
		remove(KEY_DELETE_COMMAND, "next"),
		editor.registerUpdateListener(({ editorState }) => {
			if (!editorState.read(() => $releaseNeeded(hidden))) return;
			editor.update(() => void $releaseHidden(heading, hidden), { tag: "history-merge" });
		}),
	);
}

function $releaseNeeded(hidden: Hidden): boolean {
	let selection = $getSelection();
	return $isNodeSelection(selection)
		&& selection.getNodes().every(node => $isHiddenBlock(node, hidden));
}

/** A collapsed decision renders `data-plan-collapsed`; see `InlineQuestionnaire`. */
function isHidden(editor: LexicalEditor, key: string): boolean {
	return editor.getElementByKey(key)?.querySelector("[data-plan-collapsed]") != null;
}

export function DecoratorSelectionPlugin() {
	let [editor] = useLexicalComposerContext();
	useEffect(() => registerDecoratorSelection(editor), [editor]);
	return null;
}
