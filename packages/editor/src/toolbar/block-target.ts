/**
 * Where a block chosen at the caret goes.
 *
 * Not `getTopLevelElement`: a table cell is a shadow root, so it stops inside the
 * table, and a cell holds only inline text in the dialect. Callouts, columns and
 * tabs are not shadow roots, so Lexical's own insertions treat them as inline-only.
 */

import {
	$createListItemNode,
	$createListNode,
	$isListNode,
	INSERT_CHECK_LIST_COMMAND,
	INSERT_ORDERED_LIST_COMMAND,
	INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import { $isQuoteNode } from "@lexical/rich-text";
import { $isTableCellNode } from "@lexical/table";
import {
	$createParagraphNode,
	$getSelection,
	$insertNodes,
	$isElementNode,
	$isParagraphNode,
	$isRangeSelection,
	$isRootNode,
} from "lexical";
import { CalloutNode, ColumnNode, ColumnsNode, lookup, TabNode, TabsNode } from "@chopin/dialect";

import type { ListType } from "@lexical/list";
import type { ElementNode, LexicalEditor, LexicalNode } from "lexical";

/** The root's child holding a node, and whether the node sits deeper, in a list item, cell or container. */
export function $topLevel(node: LexicalNode): { block: LexicalNode; nested: boolean } | undefined {
	let block: LexicalNode = node;
	for (
		let parent = block.getParent();
		parent && !$isRootNode(parent);
		parent = parent.getParent()
	) {
		block = parent;
	}
	if (!$isRootNode(block.getParent())) return undefined;
	let host: LexicalNode | null = node;
	while (host && !($isElementNode(host) && !host.isInline())) host = host.getParent();
	return { block, nested: host !== block };
}

/**
 * The dialect component each container node writes out as. A container is not a Lexical
 * shadow root, so it is walked like any other ancestor.
 */
export const CONTAINER_COMPONENTS: Readonly<Record<string, string>> = {
	[CalloutNode.getType()]: "Callout",
	[ColumnsNode.getType()]: "Columns",
	[ColumnNode.getType()]: "Column",
	[TabsNode.getType()]: "Tabs",
	[TabNode.getType()]: "Tab",
};

/** The nearest block element holding a node. */
function $host(node: LexicalNode | null): ElementNode | undefined {
	while (node && !($isElementNode(node) && !node.isInline())) node = node.getParent();
	return node ?? undefined;
}

/** Whether a block sits directly in a callout, column or tab, rather than the root. */
function $inContainer(block: LexicalNode): boolean {
	let parent = block.getParent();
	return !!parent && Object.hasOwn(CONTAINER_COMPONENTS, parent.getType());
}

/** A new paragraph after the caret's top-level block, holding the caret. */
function $openAfterTopLevel(): void {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return;
	let target = $topLevel(selection.anchor.getNode());
	if (!target) return;
	let paragraph = $createParagraphNode();
	target.block.insertAfter(paragraph);
	paragraph.select();
}

/**
 * Give a block chosen without typing a `/` its own line. A block with words in it gets a
 * new paragraph after it, rather than a slash splitting a word or trailing a sentence: in
 * the same callout, column or tab, but after the whole table, list or quote, which hold
 * only inline text. The chosen command then moves on only if its block is not allowed there.
 */
export function $openBlock(): void {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return;
	let host = $host(selection.anchor.getNode());
	if (!host || host.getTextContentSize() === 0) return;
	if (!$isRootNode(host.getParent()) && !$inContainer(host)) {
		$openAfterTopLevel();
		return;
	}
	let paragraph = $createParagraphNode();
	host.insertAfter(paragraph);
	paragraph.select();
}

/**
 * Move the caret to a new paragraph after its top-level block when the block about
 * to be inserted cannot live where the caret is: anywhere in a table cell, anywhere
 * nested for a top-level-only component, or in a container the dialect forbids it
 * in, such as a callout in a callout or a column. Research goes to the same place.
 */
export function $leaveForBlock(component?: string): void {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return;
	let anchor = selection.anchor.getNode();
	if (lookup(component)?.topLevel && $topLevel(anchor)?.nested) {
		$openAfterTopLevel();
		return;
	}
	for (let node: LexicalNode | null = anchor; node && !$isRootNode(node); node = node.getParent()) {
		let forbids = lookup(CONTAINER_COMPONENTS[node.getType()])?.forbids ?? [];
		if ($isTableCellNode(node) || (component && forbids.includes(component))) {
			$openAfterTopLevel();
			return;
		}
	}
}

/**
 * Insert a block node at the caret. In a callout, column or tab it goes beside the caret's
 * block, because `$insertNodes` treats those containers as inline-only and would flatten it
 * to its text, dropping a table or tabs without a trace.
 */
export function $insertBlock(block: LexicalNode): void {
	let selection = $getSelection();
	let host = $isRangeSelection(selection) ? $host(selection.anchor.getNode()) : undefined;
	if (!host || !$inContainer(host)) {
		$insertNodes([block]);
		return;
	}
	if ($isParagraphNode(host) && host.getTextContentSize() === 0) host.replace(block);
	else host.insertAfter(block);
	block.selectEnd();
}

/** The block a list conversion replaces: a quote rather than the paragraph inside it. */
function $convertible(node: LexicalNode): ElementNode | undefined {
	let host = $host(node);
	let parent = host?.getParent();
	return $isParagraphNode(host) && $isQuoteNode(parent) ? parent : host;
}

/**
 * Turn the selected blocks in a callout, column or tab into a list there. `$insertList`
 * walks up to a root or shadow root, so it would turn the whole container into the list,
 * and it moves an imported quote's paragraphs into one item whole, leaving a block in it.
 * False where `$insertList` already does the right thing.
 */
function $listInPlace(type: ListType): boolean {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return false;
	let blocks: ElementNode[] = [];
	for (let node of selection.getNodes()) {
		let block = $convertible(node);
		let wrapped = $isQuoteNode(block) && block.getChildren().some($isElementNode);
		if (!block || !($inContainer(block) || wrapped)) return false;
		if (!blocks.includes(block)) blocks.push(block);
	}
	let first = blocks[0];
	if (!first || blocks.some(block => !block.getParent()?.is(first.getParent()))) return false;

	let previous = first.getPreviousSibling();
	let list = $isListNode(previous) && previous.getListType() === type
		? previous
		: $createListNode(type);
	if (list !== previous) first.insertBefore(list);
	let item: ElementNode | undefined;
	for (let block of blocks) {
		// A quote holds paragraphs; each becomes its own item.
		let lines = $isQuoteNode(block) ? block.getChildren().filter($isElementNode) : [block];
		for (let line of lines) {
			item = $createListItemNode(type === "check" ? false : undefined);
			item.append(...line.getChildren());
			list.append(item);
		}
		block.remove();
	}
	let next = list.getNextSibling();
	if ($isListNode(next) && next.getListType() === type) {
		list.append(...next.getChildren());
		next.remove();
	}
	if (!selection.anchor.getNode().isAttached()) item?.selectEnd();
	return true;
}

const LIST_COMMANDS = {
	bullet: INSERT_UNORDERED_LIST_COMMAND,
	number: INSERT_ORDERED_LIST_COMMAND,
	check: INSERT_CHECK_LIST_COMMAND,
} as const;

/** Convert the selected blocks to a list, keeping them inside their container. */
export function insertList(editor: LexicalEditor, type: ListType): void {
	editor.update(() => {
		if (!$listInPlace(type)) editor.dispatchCommand(LIST_COMMANDS[type], undefined);
	});
}
