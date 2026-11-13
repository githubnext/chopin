/**
 * Selecting whole blocks, as Notion does.
 *
 * Escape selects the block holding the caret (or every block a text selection touches), and the
 * selection is then a Lexical node selection of those blocks, drawn on them with
 * `data-block-selected`. ArrowUp and ArrowDown move it to the block before or after, Shift with
 * them extends it, Delete and Backspace remove the blocks, Mod+C and Mod+X copy or cut them as
 * Markdown, Mod+D duplicates them, Mod+Shift+ArrowUp and ArrowDown move them, Enter goes back to
 * editing at the end of the block, and Escape lets go and gives up focus, so a sheet around the
 * editor takes the Escape after that. Each Escape dismisses the innermost thing first: an open
 * menu, popover or card closes before the blocks are selected. Clicking in text leaves block
 * selection, as Lexical turns a click into a text selection. A mouse drag that starts in one block's text and crosses
 * into another selects the blocks it crosses rather than the text.
 *
 * A block is a node whose parent holds blocks side by side: the document, a callout, a column, a
 * tab or a list (an item). The title is never one. Blocks are walked in document order, so the
 * arrows step into a callout's blocks and out again.
 *
 * Identity: a copy is made only of a block that is its own text (`$plainBlock`). A decision, a
 * question, a research request, an investigation or an experiment belongs to its record, which a
 * browser may neither remove nor create, so Delete and Cut leave those blocks where they are and a
 * copy carries none of them. Images, callouts, columns, tabs and footnotes may be deleted, as
 * they can be in text, but are never copied, duplicated or cut, since a second one would claim
 * the same identity.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isListItemNode, $isListNode } from "@lexical/list";
import {
	$createNodeSelection,
	$createParagraphNode,
	$createRangeSelectionFromDom,
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isDecoratorNode,
	$isElementNode,
	$isNodeSelection,
	$isRangeSelection,
	$isRootNode,
	$parseSerializedNode,
	$setSelection,
	CLICK_COMMAND,
	COLLABORATION_TAG,
	COMMAND_PRIORITY_CRITICAL,
	COMMAND_PRIORITY_LOW,
	COPY_COMMAND,
	CUT_COMMAND,
	HISTORY_MERGE_TAG,
	KEY_ARROW_DOWN_COMMAND,
	KEY_ARROW_UP_COMMAND,
	KEY_BACKSPACE_COMMAND,
	KEY_DELETE_COMMAND,
	KEY_DOWN_COMMAND,
	KEY_ENTER_COMMAND,
	KEY_ESCAPE_COMMAND,
	mergeRegister,
	PASTE_COMMAND,
	SELECTION_CHANGE_COMMAND,
} from "lexical";
import {
	$exportBlocks,
	$isCalloutNode,
	$isColumnNode,
	$isColumnsNode,
	$isDecisionNode,
	$isExperimentNode,
	$isInvestigationNode,
	$isQuestionnaireNode,
	$isResearchNode,
	$isTabNode,
	$isTabsNode,
} from "@chopin/dialect";

import { $isDocumentTitle } from "../document-title";
import { $liveRangeSelection } from "../live-selection";
import { isApplePlatform } from "../toolbar/shortcut";
import { $plainBlock, $serializeBlock } from "./block-keys";
import { leftCode } from "./code-keys";

import type { EditorState, ElementNode, LexicalEditor, LexicalNode, PointType } from "lexical";
import type { SerializedBlock } from "./block-keys";

export { $liveRangeSelection };

/** A list item that holds only a nested list: the list's place, not a block of its own. */
function $isWrapper(node: LexicalNode): boolean {
	return $isListItemNode(node) && node.getChildrenSize() === 1
		&& $isListNode(node.getFirstChild());
}

function $holdsBlocks(node: LexicalNode | null): boolean {
	return $isRootNode(node) || $isCalloutNode(node) || $isColumnNode(node) || $isTabNode(node)
		|| $isListNode(node);
}

/** Whether a node is a block that can be selected as one. */
export function $isBlock(node: LexicalNode): boolean {
	if ($isListNode(node) || $isWrapper(node) || $isDocumentTitle(node)) return false;
	return $holdsBlocks(node.getParent());
}

/** The block a node is in, if it is in one. */
export function $blockOf(node: LexicalNode | null): LexicalNode | undefined {
	for (let at = node; at && !$isRootNode(at); at = at.getParent()) {
		if ($isBlock(at)) return at;
	}
	return undefined;
}

/** Every block, in document order: a callout before the blocks inside it. */
export function $blocks(): LexicalNode[] {
	let found: LexicalNode[] = [];
	let walk = (node: LexicalNode) => {
		if (!$isRootNode(node) && $isBlock(node)) found.push(node);
		let inside = $isRootNode(node) || $isListNode(node) || $isListItemNode(node)
			|| $isCalloutNode(node) || $isColumnsNode(node) || $isColumnNode(node) || $isTabsNode(node)
			|| $isTabNode(node);
		if (inside && $isElementNode(node)) { for (let child of node.getChildren()) walk(child); }
	};
	walk($getRoot());
	return found;
}

/** The blocks from one to another inclusive, in document order, without those inside another. */
export function $range(anchor: LexicalNode, focus: LexicalNode): LexicalNode[] {
	let all = $blocks();
	let from = all.findIndex(block => block.is(anchor));
	let to = all.findIndex(block => block.is(focus));
	if (from < 0 || to < 0) return [];
	let slice = all.slice(Math.min(from, to), Math.max(from, to) + 1);
	return slice.filter(block => !slice.some(other => other !== block && other.isParentOf(block)));
}

/** What a block holds that its record owns, which a browser may not remove. */
function $owned(node: LexicalNode): boolean {
	if (
		$isQuestionnaireNode(node) || $isDecisionNode(node) || $isResearchNode(node)
		|| $isExperimentNode(node) || $isInvestigationNode(node)
	) return true;
	return $isElementNode(node) && node.getChildren().some($owned);
}

type Held = { anchor: string; focus: string; keys: string };

const holding = new WeakMap<LexicalEditor, Held>();

function keysOf(nodes: readonly LexicalNode[]): string {
	return nodes.map(node => node.getKey()).sort().join(" ");
}

/** Select the blocks from `anchor` to `focus` as blocks. */
export function $hold(editor: LexicalEditor, anchor: LexicalNode, focus: LexicalNode): void {
	let blocks = $range(anchor, focus);
	let selection = $createNodeSelection();
	for (let block of blocks) selection.add(block.getKey());
	$setSelection(selection);
	holding.set(editor, { anchor: anchor.getKey(), focus: focus.getKey(), keys: keysOf(blocks) });
}

/** The blocks selected as blocks, in document order, if any are. */
export function $held(
	editor: LexicalEditor,
): { anchor: LexicalNode; focus: LexicalNode; blocks: LexicalNode[] } | undefined {
	let held = holding.get(editor);
	let selection = $getSelection();
	if (!held || !$isNodeSelection(selection)) return undefined;
	let anchor = $getNodeByKey(held.anchor);
	let focus = $getNodeByKey(held.focus);
	if (!anchor?.isAttached() || !focus?.isAttached()) return undefined;
	let blocks = $range(anchor, focus);
	if (blocks.length === 0 || keysOf(blocks) !== keysOf(selection.getNodes())) return undefined;
	return { anchor, focus, blocks };
}

/**
 * Remove blocks, except what a record owns, and put the caret where they were.
 *
 * @returns false when nothing could be removed.
 */
export function $removeBlocks(blocks: readonly LexicalNode[]): boolean {
	let gone = blocks.filter(block => !$owned(block));
	if (gone.length === 0) return false;
	let inside = (node: LexicalNode) => gone.some(block => block.is(node) || block.isParentOf(node));
	let all = $blocks();
	let first = all.findIndex(block => block.is(gone[0]!));
	let lands = (node: LexicalNode) => !inside(node) && $isElementNode(node);
	let before = all.slice(0, first).toReversed().find(lands);
	let after = all.slice(first).find(lands);
	let parents = new Set<ElementNode>();
	for (let block of gone) {
		let parent = block.getParent();
		if (parent) parents.add(parent);
		block.remove();
	}
	for (let parent of parents) {
		if (!parent.isAttached() || parent.getChildrenSize() > 0) continue;
		if ($isCalloutNode(parent) || $isColumnNode(parent) || $isTabNode(parent)) {
			parent.append($createParagraphNode());
		}
	}
	let root = $getRoot();
	if (root.getChildren().every($isDocumentTitle)) root.append($createParagraphNode());
	if (before?.isAttached() && $isElementNode(before)) before.selectEnd();
	else if (after?.isAttached() && $isElementNode(after)) after.selectStart();
	else {
		let last = root.getLastChild();
		if ($isElementNode(last)) last.selectEnd();
	}
	return true;
}

/** Put copies of the blocks that are their own text after them; the copies, in order. */
export function $duplicateBlocks(blocks: readonly LexicalNode[]): LexicalNode[] {
	let copies: LexicalNode[] = [];
	let runs: LexicalNode[][] = [];
	for (let block of blocks) {
		let run = runs.at(-1);
		if (run && run.at(-1)!.getNextSibling()?.is(block)) run.push(block);
		else runs.push([block]);
	}
	for (let run of runs) {
		let after = run.at(-1)!;
		for (let block of run) {
			if (!$plainBlock(block)) continue;
			let copy = $parseSerializedNode($serializeBlock(block));
			after.insertAfter(copy);
			after = copy;
			copies.push(copy);
		}
	}
	return copies;
}

/** Move a run of sibling blocks past the block beside it; false where they are not one run. */
export function $moveBlocks(blocks: readonly LexicalNode[], direction: "up" | "down"): boolean {
	let first = blocks[0];
	let last = blocks.at(-1);
	if (!first || !last) return false;
	let run = blocks.every((block, index) =>
		index === 0 || block.getPreviousSibling()?.is(blocks[index - 1]!)
	);
	if (!run) return false;
	if (direction === "up") {
		let previous = first.getPreviousSibling();
		if (!previous || $isDocumentTitle(previous)) return false;
		last.insertAfter(previous);
	} else {
		let next = last.getNextSibling();
		if (!next) return false;
		first.insertBefore(next);
	}
	return true;
}

/** What a copy of blocks puts on the clipboard: Markdown, and Lexical's own form to paste back. */
export function $clipboard(
	editor: LexicalEditor,
	blocks: readonly LexicalNode[],
): { markdown: string; lexical: string; copied: LexicalNode[] } | undefined {
	let copied = blocks.filter($plainBlock);
	if (copied.length === 0) return undefined;
	let markdown: string;
	try {
		markdown = $exportBlocks(copied).trimEnd();
	} catch {
		markdown = copied.map(block => block.getTextContent()).join("\n\n");
	}
	let nodes: SerializedBlock[] = [];
	let list: SerializedBlock | undefined;
	let listOf: LexicalNode | undefined;
	for (let block of copied) {
		let parent = block.getParent();
		if (!$isListNode(parent)) {
			listOf = undefined;
			nodes.push($serializeBlock(block));
			continue;
		}
		if (listOf !== parent) {
			listOf = parent;
			list = { ...parent.exportJSON(), children: [] };
			nodes.push(list);
		}
		list!.children!.push($serializeBlock(block));
	}
	return {
		markdown,
		lexical: JSON.stringify({ namespace: editor._config.namespace, nodes }),
		copied,
	};
}

/** Whether a block is laid out where a person can see it (an inactive tab's is not). */
function shown(editor: LexicalEditor, node: LexicalNode): boolean {
	let element = editor.getElementByKey(node.getKey());
	return !!element && element.getClientRects().length > 0
		&& !element.querySelector("[data-plan-collapsed]");
}

function $step(
	editor: LexicalEditor,
	from: LexicalNode,
	direction: 1 | -1,
): LexicalNode | undefined {
	let all = $blocks();
	for (let at = all.findIndex(block => block.is(from)) + direction; all[at]; at += direction) {
		if (shown(editor, all[at]!)) return all[at];
	}
	return undefined;
}

/** The point that comes later in the document. */
function later(a: PointType, b: PointType): PointType {
	return a.isBefore(b) ? b : a;
}

/** The blocks a text selection reaches across, if it reaches past one. */
function $crossed(): { anchor: LexicalNode; focus: LexicalNode } | undefined {
	let selection = $getSelection();
	if (!$isRangeSelection(selection) || selection.isCollapsed()) return undefined;
	let blockAt = (point: PointType, end: boolean) => {
		let node = point.getNode();
		let block = $blockOf(node);
		// A selection that ends at the very start of a block (as a triple click's does) is the one
		// before it.
		if (end && block && point.offset === 0 && atBlockStartOf(node, block)) {
			let all = $blocks();
			let at = all.findIndex(candidate => candidate.is(block));
			return all[at - 1] ?? block;
		}
		return block;
	};
	let { anchor, focus } = selection;
	let anchorBlock = blockAt(anchor, later(anchor, focus) === anchor);
	let focusBlock = blockAt(focus, later(anchor, focus) === focus);
	if (!anchorBlock || !focusBlock || anchorBlock.is(focusBlock)) return undefined;
	return { anchor: anchorBlock, focus: focusBlock };
}

/** Whether a node starts its block: it and everything above it inside the block come first. */
function atBlockStartOf(node: LexicalNode, block: LexicalNode): boolean {
	for (let at: LexicalNode | null = node; at && !at.is(block); at = at.getParent()) {
		if (at.getPreviousSibling()) return false;
	}
	return true;
}

/** A menu, listbox, popover, card or tooltip is open on the page, outside the editor. */
function layerOpen(editor: LexicalEditor): boolean {
	let root = editor.getRootElement();
	if (!root) return false;
	let layers = root.ownerDocument.querySelectorAll(
		'[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]',
	);
	for (let layer of layers) {
		if (!layer.contains(root) && layer.getClientRects().length > 0) return true;
	}
	return false;
}

/** Write to the clipboard from a key press: the browser's copy, with this payload. */
function copy(payload: { markdown: string; lexical: string }): boolean {
	let written = false;
	let write = (event: ClipboardEvent) => {
		event.clipboardData?.setData("text/plain", payload.markdown);
		event.clipboardData?.setData("application/x-lexical-editor", payload.lexical);
		event.preventDefault();
		written = true;
	};
	document.addEventListener("copy", write, { capture: true, once: true });
	try {
		document.execCommand("copy");
	} finally {
		document.removeEventListener("copy", write, { capture: true });
	}
	if (!written) void navigator.clipboard?.writeText(payload.markdown).catch(() => {});
	return true;
}

let styled = false;

/** The blocks a drag across them reaches, until the button is let go. */
type Dragged = { anchor: string; focus: string };

/** Draw the held blocks, and nothing that is no longer held. */
function draw(
	editor: LexicalEditor,
	state: EditorState,
	drawn: Set<HTMLElement>,
	dragged: Dragged | undefined,
): void {
	let keys = state.read(() => {
		let blocks = $held(editor)?.blocks;
		if (!blocks && dragged) {
			let anchor = $getNodeByKey(dragged.anchor);
			let focus = $getNodeByKey(dragged.focus);
			if (anchor && focus) blocks = $range(anchor, focus);
		}
		return blocks?.map(block => block.getKey()) ?? [];
	}, { editor });
	let now = new Set<HTMLElement>();
	for (let key of keys) {
		let element = editor.getElementByKey(key);
		if (element) now.add(element);
	}
	if (now.size && !styled) {
		styled = true;
		void import("./block-selection.css");
	}
	for (let element of drawn) if (!now.has(element)) element.removeAttribute("data-block-selected");
	for (let element of now) element.setAttribute("data-block-selected", "");
	drawn.clear();
	for (let element of now) drawn.add(element);
}

/** A caret's place in its block: the block's text and how far into it the caret is. */
type Place = { key: string; type: string; text: string; offset: number };

function $placeOf(point: PointType): Place | undefined {
	let block = $blockOf(point.getNode());
	if (!block || !$isElementNode(block)) return undefined;
	let offset = 0;
	let node = point.getNode();
	if (point.type === "text") {
		for (let text of block.getAllTextNodes()) {
			if (text.is(node)) break;
			offset += text.getTextContentSize();
		}
		offset += point.offset;
	} else if ($isElementNode(node)) {
		for (let child of node.getChildren().slice(0, point.offset)) {
			offset += child.getTextContentSize();
		}
		for (let at: LexicalNode = node; !at.is(block); at = at.getParentOrThrow()) {
			for (let before of at.getPreviousSiblings()) offset += before.getTextContentSize();
		}
	}
	return { key: block.getKey(), type: block.getType(), text: block.getTextContent(), offset };
}

/**
 * Keep the caret in a block a collaborator moved.
 *
 * Lexical's Yjs binding has no move: it removes a moved block and makes it again, and makes again
 * every block it passed, so a caret in one of them is lost and Lexical puts it in the block before
 * (for a block moved to the top, the title). Where exactly one block of the same kind holds the
 * same text afterwards, the caret goes back to its place in it; an ambiguous match is left alone.
 */
function registerCaretKeeping(editor: LexicalEditor): () => void {
	return editor.registerUpdateListener(({ editorState, prevEditorState, tags }) => {
		if (!tags.has(COLLABORATION_TAG)) return;
		let before = prevEditorState.read(() => {
			let selection = $getSelection();
			return $isRangeSelection(selection) && selection.isCollapsed()
				? $placeOf(selection.anchor)
				: undefined;
		}, { editor });
		if (!before) return;
		let lost = editorState.read(() => !$getNodeByKey(before.key)?.isAttached(), { editor });
		if (!lost) return;
		editor.update(() => {
			let matches = $blocks().filter(block =>
				block.getType() === before.type && block.getTextContent() === before.text
			);
			let block = matches.length === 1 ? matches[0] : undefined;
			if (!$isElementNode(block)) return;
			let left = before.offset;
			for (let text of block.getAllTextNodes()) {
				let size = text.getTextContentSize();
				if (left <= size) {
					text.select(left, left);
					return;
				}
				left -= size;
			}
			block.selectEnd();
		}, { tag: HISTORY_MERGE_TAG });
	});
}

export function registerBlockSelection(editor: LexicalEditor): () => void {
	let apple = isApplePlatform();
	let drawn = new Set<HTMLElement>();
	// A primary-button press in the text, while it is held: a drag that may cross blocks.
	let down = false;
	let dragged: Dragged | undefined;

	// On the document, as overlays over the prose (comment hits, cursors) may take the press.
	let pointerdown = (event: PointerEvent) => {
		let bounds = editor.getRootElement()?.getBoundingClientRect();
		down = event.button === 0 && event.pointerType === "mouse" && !!bounds
			&& event.clientX >= bounds.left && event.clientX <= bounds.right
			&& event.clientY >= bounds.top && event.clientY <= bounds.bottom;
		dragged = undefined;
	};
	let pointerup = () => {
		if (!down) return;
		down = false;
		dragged = undefined;
		editor.getRootElement()?.removeAttribute("data-block-dragging");
		if (!editor.isEditable()) return;
		editor.update(() => {
			let crossed = $crossed();
			if (crossed) $hold(editor, crossed.anchor, crossed.focus);
		});
	};

	let scroll = (node: LexicalNode) => {
		editor.getElementByKey(node.getKey())?.scrollIntoView({ block: "nearest" });
	};

	let held = () => $held(editor);

	return mergeRegister(
		(() => {
			document.addEventListener("pointerdown", pointerdown, true);
			document.addEventListener("pointerup", pointerup, true);
			return () => {
				document.removeEventListener("pointerdown", pointerdown, true);
				document.removeEventListener("pointerup", pointerup, true);
			};
		})(),
		registerCaretKeeping(editor),
		editor.registerUpdateListener(({ editorState }) => draw(editor, editorState, drawn, dragged)),
		() => {
			for (let element of drawn) element.removeAttribute("data-block-selected");
		},
		editor.registerCommand(
			SELECTION_CHANGE_COMMAND,
			() => {
				// The text selection stays Lexical's until the button is let go; the blocks it reaches
				// are drawn as selected, and the text is not painted as well.
				if (!down || !editor.isEditable()) return false;
				let crossed = $crossed();
				let root = editor.getRootElement();
				dragged = crossed
					? { anchor: crossed.anchor.getKey(), focus: crossed.focus.getKey() }
					: undefined;
				if (dragged) root?.setAttribute("data-block-dragging", "");
				else root?.removeAttribute("data-block-dragging");
				return false;
			},
			COMMAND_PRIORITY_CRITICAL,
		),
		editor.registerCommand(
			CLICK_COMMAND,
			() => {
				// A click in text leaves the blocks for a caret where the click was. Lexical would only
				// empty the node selection, leaving no caret, and Chrome then parks one at the top.
				// The click that ends a drag across blocks has no caret to go to: the blocks stay.
				if (!held()) return false;
				let dom = editor.getRootElement()?.ownerDocument.getSelection();
				let selection = dom?.rangeCount ? $createRangeSelectionFromDom(dom, editor) : null;
				if (!selection) return true;
				$setSelection(selection);
				holding.delete(editor);
				return true;
			},
			COMMAND_PRIORITY_CRITICAL,
		),
		editor.registerCommand(
			KEY_DOWN_COMMAND,
			event => {
				if (event.key !== "Escape") leftCode.delete(editor);
				let found = held();
				if (!found) return false;
				let mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
				let key = event.key.toLowerCase();
				if (mod && event.shiftKey && !event.altKey) {
					if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
					event.preventDefault();
					if ($moveBlocks(found.blocks, event.key === "ArrowUp" ? "up" : "down")) {
						$hold(editor, found.anchor, found.focus);
						scroll(found.blocks[0]!);
					}
					return true;
				}
				if (!mod || event.shiftKey || event.altKey) return false;
				if (key === "d") {
					event.preventDefault();
					let copies = $duplicateBlocks(found.blocks);
					if (copies.length) $hold(editor, copies[0]!, copies.at(-1)!);
					return true;
				}
				if (key === "c" || key === "x") {
					event.preventDefault();
					let payload = $clipboard(editor, found.blocks);
					if (!payload) return true;
					copy(payload);
					if (key === "x") $removeBlocks(payload.copied);
					return true;
				}
				if (key === "a") {
					// Mod+A in block selection selects every block, as Notion's does.
					event.preventDefault();
					let all = $blocks().filter(block => shown(editor, block));
					if (all.length) $hold(editor, all[0]!, all.at(-1)!);
					return true;
				}
				return false;
			},
			COMMAND_PRIORITY_CRITICAL,
		),
		...[COPY_COMMAND, CUT_COMMAND].map(command =>
			editor.registerCommand(
				command,
				event => {
					let found = held();
					if (!found || !(event instanceof ClipboardEvent) || !event.clipboardData) return false;
					event.preventDefault();
					let payload = $clipboard(editor, found.blocks);
					if (!payload) return true;
					event.clipboardData.setData("text/plain", payload.markdown);
					event.clipboardData.setData("application/x-lexical-editor", payload.lexical);
					if (command === CUT_COMMAND) $removeBlocks(payload.copied);
					return true;
				},
				COMMAND_PRIORITY_CRITICAL,
			)
		),
		editor.registerCommand(
			PASTE_COMMAND,
			() => {
				// A paste with blocks selected goes in after them, on a line of its own.
				let found = held();
				if (!found) return false;
				let last = found.blocks.at(-1)!;
				let line = $createParagraphNode();
				if ($isListItemNode(last)) last.getParentOrThrow().insertAfter(line);
				else last.insertAfter(line);
				line.select();
				return false;
			},
			COMMAND_PRIORITY_CRITICAL,
		),
		...([KEY_ARROW_UP_COMMAND, KEY_ARROW_DOWN_COMMAND] as const).map(command =>
			editor.registerCommand(
				command,
				event => {
					let found = held();
					if (!found || event.altKey || event.metaKey || event.ctrlKey) return false;
					event.preventDefault();
					let direction: 1 | -1 = command === KEY_ARROW_UP_COMMAND ? -1 : 1;
					if (event.shiftKey) {
						let focus = $step(editor, found.focus, direction);
						if (focus) {
							$hold(editor, found.anchor, focus);
							scroll(focus);
						}
						return true;
					}
					// From the selection's first block going up, its last going down.
					let all = $blocks();
					let ends = [found.anchor, found.focus].sort((a, b) =>
						all.findIndex(block => block.is(a)) - all.findIndex(block => block.is(b))
					);
					let from = direction === -1 ? ends[0]! : ends[1]!;
					let next = $step(editor, from, direction);
					if (next) {
						$hold(editor, next, next);
						scroll(next);
					}
					return true;
				},
				COMMAND_PRIORITY_CRITICAL,
			)
		),
		...[KEY_BACKSPACE_COMMAND, KEY_DELETE_COMMAND].map(command =>
			editor.registerCommand(
				command,
				(event: KeyboardEvent) => {
					let found = held();
					if (!found) return false;
					event.preventDefault();
					$removeBlocks(found.blocks);
					return true;
				},
				COMMAND_PRIORITY_CRITICAL,
			)
		),
		editor.registerCommand(
			KEY_ENTER_COMMAND,
			event => {
				let found = held();
				if (!found || !$isElementNode(found.focus)) return false;
				event?.preventDefault();
				found.focus.selectEnd();
				return true;
			},
			COMMAND_PRIORITY_CRITICAL,
		),
		editor.registerCommand(
			KEY_ESCAPE_COMMAND,
			event => {
				// Escape dismisses the innermost thing first: an open menu, popover or card closes
				// before the blocks are selected.
				if (!editor.isEditable() || layerOpen(editor)) return false;
				let found = held();
				if (found) {
					// The next layer out: the blocks are let go and focus leaves the editor. The key is
					// not spent, so a sheet around the editor takes it as its own next step.
					$setSelection(null);
					holding.delete(editor);
					let root = editor.getRootElement();
					queueMicrotask(() => {
						if (root && root.ownerDocument.activeElement === root) root.blur();
					});
					return true;
				}
				// The second Escape after leaving a code block selects the block it left.
				let code = leftCode.get(editor);
				leftCode.delete(editor);
				let left = code ? $getNodeByKey(code) : null;
				if (left?.isAttached() && $isBlock(left)) {
					event.preventDefault();
					$hold(editor, left, left);
					return true;
				}
				let range = $liveRangeSelection(editor);
				if (!range) {
					let selection = $getSelection();
					if (!$isNodeSelection(selection)) return false;
					// A card or image a click selected becomes the block selection.
					let nodes = selection.getNodes();
					let block = nodes.length === 1 && $isDecoratorNode(nodes[0])
						? $blockOf(nodes[0])
						: undefined;
					if (!block) return false;
					event.preventDefault();
					$hold(editor, block, block);
					return true;
				}
				let anchor = $blockOf(range.anchor.getNode());
				let focus = $blockOf(range.focus.getNode());
				if (!anchor || !focus) return false;
				event.preventDefault();
				$hold(editor, anchor, focus);
				return true;
			},
			COMMAND_PRIORITY_LOW,
		),
	);
}

export function BlockSelectionPlugin() {
	let [editor] = useLexicalComposerContext();
	useEffect(() => registerBlockSelection(editor), [editor]);
	return null;
}
