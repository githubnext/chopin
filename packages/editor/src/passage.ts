/**
 * Where a comment's phrase is, in this editor.
 *
 * The server owns a passage and keeps it pointed at the right prose. Resolving
 * one has to happen here anyway, for the reason anchors do: a Lexical key is
 * per-editor, so the server's key for a text node means nothing in this
 * browser. The position is the shared thing, and every client resolves it for
 * itself.
 *
 * Going the other way — turning a selection into something the server can
 * verify — deliberately produces no positions at all. Block indices, the
 * digests they were read at, and the selected text are all things the server
 * can check against its own copy, so a client cannot place a comment anywhere
 * the prose does not agree it belongs.
 */

import { $getAnchorAndFocusForUserState } from "@lexical/yjs";
import {
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	$isParagraphNode,
	$isRangeSelection,
} from "lexical";
import * as Y from "yjs";

import { limits } from "@chopin/dialect";

import type { Binding } from "@lexical/yjs";
import type { BaseSelection, LexicalNode } from "lexical";
import type { Plan } from "@chopin/protocol";

/**
 * Blocks join with a newline, matching how the server reads a run.
 *
 * The two have to agree on which blocks the source addresses — empty paragraphs
 * are skipped at both ends — because an index that means a different block
 * would mark the wrong prose. They do not have to agree on the offset: the
 * server searches for the quote near it. A divergence in this convention
 * therefore shows up as `passageAt` refusing the request, which is loud, rather
 * than as a comment silently landing somewhere else.
 */
const RUN = "\n";

/** A resolved passage, as points in this editor's tree. */
export type Points = {
	anchorKey: string;
	anchorOffset: number;
	focusKey: string;
	focusOffset: number;
};

/** What `comment:start` sends: everything the server can verify for itself. */
export type Marked = {
	blocks: number[];
	quote: string;
	offset: number;
	length: number;
};

type Span = { key: string; start: number; length: number };

/**
 * A whole block, as points. Call inside a read.
 *
 * Child indices rather than text offsets: what a decision produced is block
 * granular, and `createDOMRange` reads an element point as a child index. A
 * block with nothing in it has no range worth marking.
 */
export function $blockPoints(key: string): Points | undefined {
	let node = $getNodeByKey(key);
	if (!$isElementNode(node)) return undefined;

	let size = node.getChildrenSize();
	if (size === 0) return undefined;
	return { anchorKey: key, anchorOffset: 0, focusKey: key, focusOffset: size };
}

/** The blocks the source addresses, in order. Call inside a read. */
function $addressable(): LexicalNode[] {
	return $getRoot().getChildren().filter(
		node => !($isParagraphNode(node) && node.getChildrenSize() === 0),
	);
}

/** A block run as one string, with where each text node sits in it. */
function $runOf(nodes: LexicalNode[]): { text: string; spans: Span[] } {
	let spans: Span[] = [];
	let text = "";

	for (let [i, node] of nodes.entries()) {
		if (i > 0) text += RUN;
		if (!$isElementNode(node)) continue;
		for (let leaf of node.getAllTextNodes()) {
			let value = leaf.getTextContent();
			spans.push({ key: leaf.getKey(), start: text.length, length: value.length });
			text += value;
		}
	}

	return { text, spans };
}

function indexOfPoint(spans: Span[], key: string, offset: number): number | undefined {
	for (let span of spans) {
		if (span.key === key) return span.start + Math.min(offset, span.length);
	}
	return undefined;
}

/** The top-level block a node sits in. Call inside a read. */
function $blockOf(node: LexicalNode): LexicalNode {
	let current = node;
	while (true) {
		let parent = current.getParent();
		if (!parent || parent.getKey() === "root") return current;
		current = parent;
	}
}

/**
 * Describe a selection as something the server can check.
 *
 * Returns nothing for a collapsed selection, or one whose blocks are not
 * addressable — there is no phrase to mark in either case.
 */
export function $describe(selection: BaseSelection | null): Marked | undefined {
	if (!$isRangeSelection(selection) || selection.isCollapsed()) return undefined;

	let all = $addressable();
	let first = all.indexOf($blockOf(selection.anchor.getNode()));
	let last = all.indexOf($blockOf(selection.focus.getNode()));
	if (first === -1 || last === -1) return undefined;
	if (first > last) [first, last] = [last, first];

	let blocks = [];
	for (let index = first; index <= last; index++) blocks.push(index);

	let run = $runOf(blocks.map(index => all[index]!));
	let from = indexOfPoint(run.spans, selection.anchor.key, selection.anchor.offset);
	let to = indexOfPoint(run.spans, selection.focus.key, selection.focus.offset);
	if (from === undefined || to === undefined) return undefined;
	if (from > to) [from, to] = [to, from];
	if (from === to) return undefined;

	return {
		blocks,
		// A bounded locator, not the phrase: `length` carries the real extent,
		// so a long selection is marked rather than refused for being long.
		quote: run.text.slice(from, to).slice(0, limits.MAX_QUOTE),
		offset: from,
		length: to - from,
	};
}

/**
 * The points a passage names here, or nothing if it names none.
 *
 * The inverse of the arithmetic the server had to reimplement. This half is
 * exported by `@lexical/yjs`, so it is theirs to keep correct.
 */
export function locate(binding: Binding, passage: Plan.Passage): Points | undefined {
	if (passage.drifted) return undefined;

	try {
		let found = $getAnchorAndFocusForUserState(binding, {
			anchorPos: decode(passage.start),
			focusPos: decode(passage.end),
			color: "",
			focusing: false,
			name: "",
			awarenessData: {},
		});

		let { anchorKey, anchorOffset, focusKey, focusOffset } = found;
		if (!anchorKey || !focusKey) return undefined;
		return { anchorKey, anchorOffset, focusKey, focusOffset };
	} catch {
		// A position from a history this document no longer holds. The server
		// rebases these; `$recover` is what covers the gap until it has.
		return undefined;
	}
}

/**
 * Find the phrase by reading, when its positions cannot be resolved.
 *
 * A block that moved loses its collaborative identity, and with it every
 * position inside it, until the server's next rebase — up to two seconds in
 * which the highlight would otherwise blink out. The server does the durable
 * version of this; here it only has to last until the next snapshot arrives.
 */
export function $recover(passage: Plan.Passage, keys: string[]): Points | undefined {
	if (passage.drifted || keys.length === 0) return undefined;

	let nodes: LexicalNode[] = [];
	let all = $addressable();
	for (let key of keys) {
		let node = all.find(candidate => candidate.getKey() === key);
		if (!node) return undefined;
		nodes.push(node);
	}

	let run = $runOf(nodes);
	let at = run.text.indexOf(passage.quote);
	// Two occurrences of the same phrase recover neither, which is the rule
	// the server applies for the same reason: the wrong sentence is worse.
	if (at === -1 || run.text.indexOf(passage.quote, at + 1) !== -1) return undefined;

	let from = place(run.spans, at);
	let to = place(run.spans, Math.min(at + passage.length, run.text.length));
	if (!from || !to) return undefined;

	return {
		anchorKey: from.key,
		anchorOffset: from.offset,
		focusKey: to.key,
		focusOffset: to.offset,
	};
}

function place(spans: Span[], index: number): { key: string; offset: number } | undefined {
	for (let span of spans) {
		if (index <= span.start + span.length) {
			return { key: span.key, offset: Math.max(0, index - span.start) };
		}
	}
	let last = spans.at(-1);
	return last ? { key: last.key, offset: last.length } : undefined;
}

function decode(value: string): Y.RelativePosition {
	let binary = atob(value);
	let out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return Y.decodeRelativePosition(out);
}
