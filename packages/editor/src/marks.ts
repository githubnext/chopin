/**
 * Marking the prose a sidecar card refers to.
 *
 * Through the CSS Custom Highlight API, which is what Lexical already uses for
 * remote selections. Ranges live in a document-wide registry keyed by name and
 * are styled by `::highlight()` rules, so nothing is inserted into the tree:
 * the dialect has no mark node, and adding one would put one reader's pointer
 * into everybody's document and make it undoable.
 *
 * One mark, and only while somebody is pointing at the card that owns it.
 * Standing marks were tried and taken out again: a plan accumulates decisions,
 * so anything painted permanently ends up painted over most of the prose, and
 * a document that is mostly highlighted says nothing at all. Which prose a
 * comment or a decision concerns is the sidecar's to answer, and it answers on
 * demand.
 *
 * One mechanism for both halves of the sidecar, too. Questions used to outline
 * a block through a DOM attribute while comments washed a range, so the same
 * fact — this is the prose that card refers to — read as two different things
 * depending on which card it came from. `::highlight()` cannot draw an outline,
 * so the wash is what they can both be.
 *
 * The registry is document-wide, so it is owned here rather than by either
 * store. Each declares what it wants marked and the union is painted; neither
 * can erase the other by repainting itself.
 *
 * The name cannot collide with Lexical's, which are `lexical-cursor-<id>`.
 *
 * Where the API is missing the prose cannot be washed, so the blocks it covers
 * are outlined instead. Less precise, and honest about it, which beats
 * hand-positioning rectangles over text that scrolls.
 */

import { $getNodeByKey } from "lexical";

import { createDOMRange } from "@lexical/selection";

import type { LexicalEditor } from "lexical";
import type { Points } from "./passage";

/** Which store a mark came from. */
export type Owner = "questions" | "comments";

const NAME = "plan-related";

/** What each store wants marked, most recently declared. */
const wanted = new Map<Owner, Points[]>();

/**
 * Everything to paint.
 *
 * Pure, and exported for that reason: whether two stores can coexist in one
 * registry is the part of this worth testing, and it is the part that does not
 * need a browser.
 */
export function union(): Points[] {
	return [...wanted.values()].flat();
}

function available(): boolean {
	return typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight === "function";
}

/** Build the DOM range a passage covers. Call inside a read. */
export function $rangeOf(editor: LexicalEditor, points: Points): Range | null {
	let anchor = $getNodeByKey(points.anchorKey);
	let focus = $getNodeByKey(points.focusKey);
	if (!anchor || !focus) return null;

	return createDOMRange(editor, anchor, points.anchorOffset, focus, points.focusOffset);
}

/**
 * Declare what one store wants marked, and repaint.
 *
 * Wholesale rather than incremental: the registry is small, the ranges are
 * invalidated by any edit anywhere, and a diff would be a second model of what
 * is on screen for no gain.
 */
export function paint(editor: LexicalEditor, owner: Owner, places: Points[]): void {
	try {
		wanted.set(owner, places);
		if (!available()) return fallback(editor);

		let ranges: Range[] = [];
		editor.getEditorState().read(() => {
			for (let points of union()) {
				let range = $rangeOf(editor, points);
				if (range) ranges.push(range);
			}
		});

		if (ranges.length === 0) CSS.highlights.delete(NAME);
		else CSS.highlights.set(NAME, new Highlight(...ranges));
	} catch (err) {
		// This is reached from a Lexical update listener, and Lexical runs
		// those in one unisolated loop — a throw here would skip the listener
		// that syncs the document. Losing a highlight is the cheapest possible
		// outcome and the only acceptable one.
		console.error("[plan] could not mark prose:", err);
	}
}

/** Take every mark down. Called when the editor goes away. */
export function clear(editor?: LexicalEditor): void {
	wanted.clear();
	if (available()) CSS.highlights.delete(NAME);
	if (editor) outline(editor, []);
}

/** Blocks currently outlined by the fallback, so they can be un-outlined. */
const outlined = new WeakMap<LexicalEditor, string[]>();

function fallback(editor: LexicalEditor): void {
	let keys: string[] = [];
	for (let points of union()) {
		let block = blockOf(editor, points.anchorKey);
		if (block && !keys.includes(block)) keys.push(block);
	}
	outline(editor, keys);
}

/**
 * The block a key sits in.
 *
 * Guarded per key: one that cannot be resolved is one outline nobody gets, and
 * abandoning the rest of the marks over it would be a worse answer than
 * drawing the ones that do resolve.
 */
function blockOf(editor: LexicalEditor, key: string): string | undefined {
	let found: string | undefined;
	try {
		editor.getEditorState().read(() => {
			let node = $getNodeByKey(key);
			while (node) {
				let parent = node.getParent();
				if (!parent || parent.getKey() === "root") break;
				node = parent;
			}
			found = node?.getKey();
		});
	} catch {
		return undefined;
	}
	return found;
}

function outline(editor: LexicalEditor, keys: string[]): void {
	for (let key of outlined.get(editor) ?? []) {
		editor.getElementByKey(key)?.removeAttribute("data-plan-related");
	}
	for (let key of keys) {
		editor.getElementByKey(key)?.setAttribute("data-plan-related", "");
	}
	outlined.set(editor, keys);
}
