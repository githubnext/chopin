/**
 * Marking prose the sidecar refers to.
 *
 * Through the CSS Custom Highlight API, which is what Lexical already uses for
 * remote selections. Ranges live in a document-wide registry keyed by name and
 * are styled by `::highlight()` rules, so nothing is inserted into the tree:
 * the dialect has no mark node, and adding one would put one reader's pointer
 * into everybody's document and make it undoable.
 *
 * One mechanism for both features, deliberately. Questions used to outline a
 * block through a DOM attribute while comments washed a range, so the same
 * fact — this prose is what that decision produced — looked like two different
 * things depending on which half of the sidecar it came from. `::highlight()`
 * cannot draw an outline, so the wash is what they can both be.
 *
 * The registry is document-wide, so it is owned here rather than by either
 * store. Each declares what it wants marked and the union is painted; neither
 * can erase the other by repainting itself.
 *
 * Names cannot collide with Lexical's, which are `lexical-cursor-<id>`.
 *
 * Overlapping ranges in one highlight paint once, which is what makes two
 * comments on the same sentence look like one mark. Telling them apart is the
 * sidecar's job, and clicking is resolved to the innermost.
 *
 * Where the API is missing the prose cannot be washed, so the blocks it covers
 * are outlined instead. Less precise, and honest about it, which beats
 * hand-positioning rectangles over text that scrolls.
 */

import { $getNodeByKey } from "lexical";

import { createDOMRange } from "@lexical/selection";

import type { LexicalEditor } from "lexical";
import type { Points } from "./passage";

/**
 * What a mark says.
 *
 * `related` is the reader's pointer and belongs to whichever card they are
 * touching, so it is shared: hovering a question and hovering a comment light
 * their prose the same way. The other two are standing marks, and say what is
 * true of the prose rather than what the reader is doing.
 */
export type Tone = "comment" | "decision" | "related";

/** Which store a mark came from. */
export type Owner = "questions" | "comments";

export type Marked = { tone: Tone; points: Points };

const NAMES: Record<Tone, string> = {
	comment: "plan-comment",
	decision: "plan-decision",
	related: "plan-related",
};

/**
 * Which mark wins where two cover the same words.
 *
 * Set explicitly rather than left to registration order: the pointer has to
 * beat a standing mark, and a rule that depends on the order a `Map` happened
 * to be built in is a rule nobody can see.
 */
const PRIORITY: Record<Tone, number> = { decision: 0, comment: 1, related: 2 };

/** What each store wants marked, most recently declared. */
const wanted = new Map<Owner, Marked[]>();

/**
 * Everything to paint, by tone.
 *
 * Pure, and exported for that reason: whether two stores can coexist in one
 * registry is the part of this worth testing, and it is the part that does not
 * need a browser.
 */
export function union(): Map<Tone, Points[]> {
	let out = new Map<Tone, Points[]>();
	for (let marks of wanted.values()) {
		for (let mark of marks) out.set(mark.tone, [...out.get(mark.tone) ?? [], mark.points]);
	}
	return out;
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
export function paint(editor: LexicalEditor, owner: Owner, marks: Marked[]): void {
	try {
		wanted.set(owner, marks);
		if (!available()) return fallback(editor);

		let ranges = new Map<Tone, Range[]>();
		editor.getEditorState().read(() => {
			for (let [tone, places] of union()) {
				for (let points of places) {
					let range = $rangeOf(editor, points);
					if (range) ranges.set(tone, [...ranges.get(tone) ?? [], range]);
				}
			}
		});

		for (let [tone, name] of Object.entries(NAMES) as Array<[Tone, string]>) {
			let list = ranges.get(tone);
			if (!list || list.length === 0) {
				CSS.highlights.delete(name);
				continue;
			}
			let highlight = new Highlight(...list);
			highlight.priority = PRIORITY[tone];
			CSS.highlights.set(name, highlight);
		}
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
	if (available()) {
		for (let name of Object.values(NAMES)) CSS.highlights.delete(name);
	}
	if (editor) outline(editor, []);
}

/** Blocks currently outlined by the fallback, so they can be un-outlined. */
const outlined = new WeakMap<LexicalEditor, string[]>();

function fallback(editor: LexicalEditor): void {
	let keys: string[] = [];
	for (let [tone, places] of union()) {
		// A standing mark on every decided passage would outline half the plan;
		// without the API the pointer is the only one worth drawing.
		if (tone !== "related") continue;
		for (let points of places) {
			let block = blockOf(editor, points.anchorKey);
			if (block && !keys.includes(block)) keys.push(block);
		}
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
