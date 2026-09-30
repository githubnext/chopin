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

/**
 * Step over the hidden blocks next to the caret, if there are any.
 *
 * Vertical movement is left to the browser, which keeps the caret's column and
 * has nothing to land on in a block that is not displayed; all that has to be
 * done is to stop Lexical selecting the block first. Horizontal movement has no
 * such fallback, so it places the caret itself.
 */
export function $skipHidden(
	direction: Direction,
	vertical: boolean,
	hidden: (key: string) => boolean,
): "native" | "moved" | undefined {
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

	let target = skip(
		siblings,
		from,
		direction,
		node => $isDecoratorNode(node) && !node.isInline() && hidden(node.getKey()),
	);
	if (!target) return undefined;

	let landing = siblings[target.at]!;
	if ($isDecoratorNode(landing)) {
		if (vertical) return undefined;
		let nodes = $createNodeSelection();
		nodes.add(landing.getKey());
		$setSelection(nodes);
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

export function registerDecoratorSelection(
	editor: LexicalEditor,
	hidden: (key: string) => boolean = key => isHidden(editor, key),
): () => void {
	let arrow = (command: LexicalCommand<KeyboardEvent>, direction: Direction, vertical: boolean) =>
		editor.registerCommand(
			command,
			event => {
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
	);
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
