/**
 * Where a block chosen at the caret goes.
 *
 * Not `getTopLevelElement`: a table cell is a shadow root, so it stops inside the
 * table, and a cell holds only inline text in the dialect. Callouts, columns and
 * tabs are not shadow roots, so `$insertNodes` flattens a block placed in them to
 * its inline text, which drops a table or tabs without a trace.
 */

import { $createListItemNode, $createListNode } from "@lexical/list";
import { $isTableCellNode } from "@lexical/table";
import {
	$createParagraphNode,
	$getSelection,
	$insertNodes,
	$isElementNode,
	$isParagraphNode,
	$isRangeSelection,
	$isRootNode,
	$isRootOrShadowRoot,
} from "lexical";
import { $isCalloutNode, $isColumnNode, $isTabNode, $isTabsNode, lookup } from "@chopin/dialect";

import type { ElementNode, LexicalNode } from "lexical";

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
 * Give a block typed without a `/` its own line: one with words in it gets a new
 * paragraph after its top-level block, rather than a slash splitting a word or
 * trailing a sentence, or landing inside a table.
 */
export function $openBlock(): void {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return;
	let target = $topLevel(selection.anchor.getNode());
	if (target && target.block.getTextContentSize() > 0) $openAfterTopLevel();
}

function componentName(node: LexicalNode): string | undefined {
	if ($isCalloutNode(node)) return "Callout";
	if ($isColumnNode(node)) return "Column";
	if ($isTabNode(node)) return "Tab";
	if ($isTabsNode(node)) return "Tabs";
	return undefined;
}

/**
 * Move the caret to a new paragraph after its top-level block when the block about
 * to be inserted cannot live where the caret is: anywhere in a table cell, or in a
 * container the dialect forbids it in, such as a callout in a callout or a column.
 * This is where Research goes from the same places.
 */
export function $leaveForBlock(component?: string): void {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return;
	let node: LexicalNode | null = selection.anchor.getNode();
	for (; node && !$isRootNode(node); node = node.getParent()) {
		let forbids = lookup(componentName(node))?.forbids ?? [];
		if ($isTableCellNode(node) || (component && forbids.includes(component))) {
			$openAfterTopLevel();
			return;
		}
	}
}

/**
 * The caret's block when it sits in a callout, column or tab, the containers `$insertNodes`
 * and `$insertList` treat as inline-only: one flattens a block to its text there, the other
 * turns the whole container into the list.
 */
function $containedBlock(): ElementNode | undefined {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) return undefined;
	let host: LexicalNode | null = selection.anchor.getNode();
	while (host && !($isElementNode(host) && !host.isInline())) host = host.getParent();
	let parent = host?.getParent();
	if (!$isElementNode(host) || !parent || $isRootOrShadowRoot(parent)) return undefined;
	return host.isParentRequired() ? undefined : host;
}

/** Insert a block node at the caret, in a container too, where `$insertNodes` would drop it. */
export function $insertBlock(block: LexicalNode): void {
	let host = $containedBlock();
	if (!host) {
		$insertNodes([block]);
		return;
	}
	if ($isParagraphNode(host) && host.getTextContentSize() === 0) host.replace(block);
	else host.insertAfter(block);
	block.selectEnd();
}

/** Turn the caret's paragraph in a container into a task list. False where `$insertList` works. */
export function $taskListInContainer(): boolean {
	let host = $containedBlock();
	if (!$isParagraphNode(host)) return false;
	let item = $createListItemNode(false);
	item.append(...host.getChildren());
	host.replace($createListNode("check").append(item));
	item.selectEnd();
	return true;
}
