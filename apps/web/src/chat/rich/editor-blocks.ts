/**
 * The rich draft's Lexical tree as the blocks `draft-markdown.ts` writes, and back; and where a
 * point of the tree is in the Markdown it is written as, and back. Every function here runs inside
 * a Lexical read or update.
 */

import { $createLinkNode, $isLinkNode } from "@lexical/link";
import { $createListItemNode, $createListNode, $isListItemNode, $isListNode } from "@lexical/list";
import {
	$createLineBreakNode,
	$createParagraphNode,
	$createRangeSelection,
	$createTextNode,
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	$isLineBreakNode,
	$isParagraphNode,
	$isRootNode,
	$isTextNode,
	$setSelection,
} from "lexical";

import {
	$createChipNode,
	$createCodeBlockNode,
	$isChipNode,
	$isCodeBlockNode,
	$isInterimNode,
} from "./nodes";

import type { ListNode } from "@lexical/list";
import type { ElementNode, LexicalNode, RangeSelection, TextFormatType } from "lexical";
import type { Block, DraftItem, DraftLink, Leaf, Marks, Serialized, Slot } from "./draft-markdown";

export type Point = { key: string; offset: number; type: "text" | "element" };

const FORMATS: Array<[keyof Marks, TextFormatType]> = [
	["bold", "bold"],
	["italic", "italic"],
	["strike", "strikethrough"],
	["code", "code"],
];

function marksOf(node: { hasFormat: (format: TextFormatType) => boolean }): Marks {
	let marks: Marks = {};
	for (let [mark, format] of FORMATS) if (node.hasFormat(format)) marks[mark] = true;
	return marks;
}

function $readInline(nodes: readonly LexicalNode[], link?: DraftLink): Leaf[] {
	let leaves: Leaf[] = [];
	for (let node of nodes) {
		if ($isInterimNode(node)) continue;
		if ($isLineBreakNode(node)) leaves.push({ type: "break", key: node.getKey() });
		else if ($isChipNode(node)) {
			leaves.push({
				type: "reference",
				text: node.getTextContent(),
				reference: node.getReference(),
				marks: marksOf(node),
				key: node.getKey(),
				...(link ? { link } : {}),
			});
		} else if ($isTextNode(node)) {
			let text = node.getTextContent();
			if (text) {
				leaves.push({
					type: "text",
					text,
					marks: marksOf(node),
					key: node.getKey(),
					...(link ? { link } : {}),
				});
			}
		} else if ($isLinkNode(node)) {
			leaves.push(...$readInline(node.getChildren(), { url: node.getURL(), key: node.getKey() }));
		} else if ($isElementNode(node)) leaves.push(...$readInline(node.getChildren(), link));
	}
	return leaves;
}

/** A list's items, with any list nested in one read as items of its own after it. */
function $readItems(list: ListNode): DraftItem[] {
	let items: DraftItem[] = [];
	for (let item of list.getChildren()) {
		if (!$isListItemNode(item)) continue;
		let children = item.getChildren();
		let nested = children.filter($isListNode);
		let inline = children.filter(child => !$isListNode(child));
		if (inline.length > 0 || nested.length === 0) {
			items.push({ key: item.getKey(), leaves: $readInline(inline) });
		}
		for (let inner of nested) items.push(...$readItems(inner));
	}
	return items;
}

/** The text of a code block: its lines, a line break between each. */
export function $codeText(block: ElementNode): string {
	return block.getChildren().map(child => $isLineBreakNode(child) ? "\n" : child.getTextContent())
		.join("");
}

/** The draft as blocks, each piece keyed by its node, so the Markdown says where each is. */
export function $readBlocks(): Block[] {
	let blocks: Block[] = [];
	for (let node of $getRoot().getChildren()) {
		if ($isListNode(node)) {
			blocks.push({
				type: "list",
				ordered: node.getListType() === "number",
				start: node.getStart(),
				items: $readItems(node),
				key: node.getKey(),
			});
		} else if ($isCodeBlockNode(node)) {
			blocks.push({ type: "code", lang: "", text: $codeText(node), key: node.getKey() });
		} else if ($isElementNode(node)) {
			blocks.push({
				type: "paragraph",
				leaves: $readInline(node.getChildren()),
				key: node.getKey(),
			});
		}
	}
	return blocks;
}

/** The nodes of a run of leaves: text with its marks, chips, line breaks, and links round them. */
export function $inlineNodes(leaves: readonly Leaf[]): LexicalNode[] {
	let nodes: LexicalNode[] = [];
	let link: { at?: DraftLink; node?: ElementNode } = {};
	for (let leaf of leaves) {
		if (leaf.type === "break") {
			link = {};
			nodes.push($createLineBreakNode());
			continue;
		}
		let node = leaf.type === "reference"
			? $createChipNode(leaf.text, leaf.reference)
			: $createTextNode(leaf.text);
		for (let [mark, format] of FORMATS) if (leaf.marks[mark]) node.toggleFormat(format);
		if (!leaf.link) {
			link = {};
			nodes.push(node);
			continue;
		}
		if (link.at !== leaf.link) {
			link = { at: leaf.link, node: $createLinkNode(leaf.link.url) };
			nodes.push(link.node!);
		}
		link.node!.append(node);
	}
	return nodes;
}

/** The tree for these blocks, in place of what the draft held. */
export function $writeBlocks(blocks: readonly Block[]): void {
	let root = $getRoot();
	root.clear();
	for (let block of blocks) {
		if (block.type === "paragraph") {
			root.append($createParagraphNode().append(...$inlineNodes(block.leaves)));
		} else if (block.type === "list") {
			let list = $createListNode(block.ordered ? "number" : "bullet", block.start);
			for (let item of block.items) {
				list.append($createListItemNode().append(...$inlineNodes(item.leaves)));
			}
			root.append(list);
		} else {
			let code = $createCodeBlockNode();
			for (let [index, line] of block.text.split("\n").entries()) {
				if (index > 0) code.append($createLineBreakNode());
				if (line) code.append($createTextNode(line));
			}
			root.append(code);
		}
	}
	if (root.getChildrenSize() === 0) root.append($createParagraphNode());
}

export type SlotIndex = { serialized: Serialized; byKey: Map<string, Slot> };

export function slotIndex(serialized: Serialized): SlotIndex {
	return { serialized, byKey: new Map(serialized.slots.map(slot => [slot.key, slot])) };
}

function leafStart(slot: Extract<Slot, { kind: "leaf" }>): number {
	return slot.segments[0]!.md;
}

function leafEnd(slot: Extract<Slot, { kind: "leaf" }>): number {
	let last = slot.segments.at(-1)!;
	return last.md + last.length;
}

function $codeAncestor(node: LexicalNode): ElementNode | undefined {
	let parent = node.getParent();
	return parent && $isCodeBlockNode(parent) ? parent : undefined;
}

/** How many characters of a code block's text come before its child at `index`. */
function $codeChars(block: ElementNode, index: number): number {
	let count = 0;
	for (let child of block.getChildren().slice(0, index)) {
		count += $isLineBreakNode(child) ? 1 : child.getTextContent().length;
	}
	return count;
}

function $nodeStart(node: LexicalNode, index: SlotIndex): number | undefined {
	let slot = index.byKey.get(node.getKey());
	if (slot?.kind === "leaf") return leafStart(slot);
	if (slot?.kind === "break") return slot.md;
	if (slot?.kind === "element") return slot.start;
	if ($isElementNode(node)) {
		for (let child of node.getChildren()) {
			let start = $nodeStart(child, index);
			if (start !== undefined) return start;
		}
	}
	return undefined;
}

function $nodeEnd(node: LexicalNode, index: SlotIndex): number | undefined {
	let slot = index.byKey.get(node.getKey());
	if (slot?.kind === "leaf") return leafEnd(slot);
	if (slot?.kind === "break") return slot.md + 1;
	if (slot?.kind === "element") return slot.end;
	if ($isElementNode(node)) {
		for (let child of node.getChildren().toReversed()) {
			let end = $nodeEnd(child, index);
			if (end !== undefined) return end;
		}
	}
	return undefined;
}

/** Where the place before an element's child at `at` is in the Markdown. */
function $elementOffset(element: ElementNode, at: number, index: SlotIndex): number {
	if ($isCodeBlockNode(element)) {
		let slot = index.byKey.get(element.getKey());
		return (slot?.kind === "element" ? slot.start : 0) + $codeChars(element, at);
	}
	let children = element.getChildren();
	for (let child of children.slice(at)) {
		let start = $nodeStart(child, index);
		if (start !== undefined) return start;
	}
	for (let child of children.slice(0, at).toReversed()) {
		let end = $nodeEnd(child, index);
		if (end !== undefined) return end;
	}
	let slot = index.byKey.get(element.getKey());
	if (slot?.kind === "element") return slot.start;
	if ($isRootNode(element)) return 0;
	let parent = element.getParent();
	return parent ? $elementOffset(parent, element.getIndexWithinParent(), index) : 0;
}

/** Where a point of the tree is in the Markdown the draft is written as. */
export function $pointOffset(point: Point, index: SlotIndex): number {
	let node = $getNodeByKey(point.key);
	if (!node) return index.serialized.markdown.length;
	if (point.type === "element" && $isElementNode(node)) {
		return $elementOffset(node, point.offset, index);
	}
	let code = $codeAncestor(node);
	if (code) {
		let slot = index.byKey.get(code.getKey());
		return (slot?.kind === "element" ? slot.start : 0)
			+ $codeChars(code, node.getIndexWithinParent()) + point.offset;
	}
	let slot = index.byKey.get(point.key);
	if (slot?.kind === "leaf") {
		if (slot.token) return point.offset > 0 ? leafEnd(slot) : leafStart(slot);
		for (let segment of slot.segments) {
			if (point.offset >= segment.at && point.offset <= segment.at + segment.length) {
				return segment.md + point.offset - segment.at;
			}
		}
		return leafEnd(slot);
	}
	let parent = node.getParent();
	if (!parent) return 0;
	return $elementOffset(parent, node.getIndexWithinParent() + (point.offset > 0 ? 1 : 0), index);
}

function $codePoint(block: ElementNode, remaining: number): Point {
	for (let [at, child] of block.getChildren().entries()) {
		if ($isLineBreakNode(child)) {
			if (remaining === 0) return { key: block.getKey(), offset: at, type: "element" };
			remaining -= 1;
			continue;
		}
		let length = child.getTextContent().length;
		if (remaining <= length) return { key: child.getKey(), offset: remaining, type: "text" };
		remaining -= length;
	}
	return { key: block.getKey(), offset: block.getChildrenSize(), type: "element" };
}

/**
 * The point of the tree at an offset of the Markdown. An offset inside the marks of a format is the
 * start of the words after them; one past the end is the end of the draft.
 */
export function $offsetPoint(offset: number, index: SlotIndex): Point {
	let { slots } = index.serialized;
	for (let slot of slots) {
		if (slot.kind === "leaf") {
			if (slot.token) {
				if (offset === leafStart(slot)) return { key: slot.key, offset: 0, type: "text" };
				if (offset > leafStart(slot) && offset <= leafEnd(slot)) {
					return { key: slot.key, offset: slot.segments[0]!.length, type: "text" };
				}
				continue;
			}
			for (let segment of slot.segments) {
				if (offset >= segment.md && offset <= segment.md + segment.length) {
					return { key: slot.key, offset: segment.at + offset - segment.md, type: "text" };
				}
			}
		} else if (slot.kind === "break") {
			if (offset !== slot.md) continue;
			let node = $getNodeByKey(slot.key);
			let parent = node?.getParent();
			if (node && parent) {
				return { key: parent.getKey(), offset: node.getIndexWithinParent(), type: "element" };
			}
		} else if (offset >= slot.start && offset <= slot.end) {
			let node = $getNodeByKey(slot.key);
			if ($isCodeBlockNode(node)) return $codePoint(node, offset - slot.start);
			if (slot.empty && $isElementNode(node)) return { key: slot.key, offset: 0, type: "element" };
		}
	}
	for (let slot of slots) {
		if (slot.kind !== "element" || slot.end !== offset) continue;
		let node = $getNodeByKey(slot.key);
		if (($isParagraphNode(node) || $isListItemNode(node)) && $isElementNode(node)) {
			return { key: slot.key, offset: node.getChildrenSize(), type: "element" };
		}
	}
	let after = slots.find(slot =>
		(slot.kind === "leaf" ? leafStart(slot) : slot.kind === "break" ? slot.md : slot.start) > offset
	);
	if (after) {
		let start = after.kind === "leaf"
			? leafStart(after)
			: after.kind === "break"
			? after.md
			: after.start;
		return $offsetPoint(start, index);
	}
	return $endPoint();
}

/** The very end of the draft. */
export function $endPoint(): Point {
	let node: LexicalNode = $getRoot();
	while ($isElementNode(node) && node.getChildrenSize() > 0) node = node.getLastChild()!;
	if ($isTextNode(node)) {
		return { key: node.getKey(), offset: node.getTextContentSize(), type: "text" };
	}
	if ($isElementNode(node)) return { key: node.getKey(), offset: 0, type: "element" };
	let parent = node.getParent()!;
	return { key: parent.getKey(), offset: parent.getChildrenSize(), type: "element" };
}

/** A selection of the tree between two offsets of the Markdown, typing with the marks at its start. */
export function $selectOffsets(start: number, end: number, index: SlotIndex): RangeSelection {
	let anchor = $offsetPoint(start, index);
	let focus = start === end ? anchor : $offsetPoint(end, index);
	let selection = $createRangeSelection();
	selection.anchor.set(anchor.key, anchor.offset, anchor.type);
	selection.focus.set(focus.key, focus.offset, focus.type);
	let node = $getNodeByKey(anchor.key);
	if ($isTextNode(node) && !$isChipNode(node)) selection.format = node.getFormat();
	$setSelection(selection);
	return selection;
}
