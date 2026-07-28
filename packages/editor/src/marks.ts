/**
 * Marking commented prose.
 *
 * Through the CSS Custom Highlight API, which is what Lexical already uses for
 * remote selections. Ranges live in a document-wide registry keyed by name and
 * are styled by `::highlight()` rules, so nothing is inserted into the tree:
 * the dialect has no mark node, and adding one would put one reader's pointer
 * into everybody's document and make it undoable.
 *
 * The names cannot collide with Lexical's, which are `lexical-cursor-<id>`.
 *
 * Overlapping ranges in one highlight paint once rather than stacking, which is
 * what makes two comments on the same sentence look like one mark. Telling them
 * apart is the sidecar's job, and clicking is resolved to the innermost.
 *
 * Where the API is missing the whole passage cannot be marked, so the blocks it
 * covers are outlined instead — the same `data-plan-related` treatment a
 * decision's prose already gets. Less precise, and honest about it, which beats
 * hand-positioning rectangles over text that scrolls.
 */

import { createDOMRange } from "@lexical/selection";
import { $getNodeByKey } from "lexical";

import type { LexicalEditor } from "lexical";
import type { Points } from "./passage";

/** What a marked passage is: open comment, the one in focus, or decided. */
export type Tone = "open" | "current" | "decided";

const NAMES: Record<Tone, string> = {
	open: "plan-comment",
	current: "plan-comment-current",
	decided: "plan-decision",
};

export type Marked = { tone: Tone; points: Points };

function available(): boolean {
	return typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight === "function";
}

/** Build the DOM range a passage covers. Call inside a read. */
function $rangeOf(editor: LexicalEditor, points: Points): Range | null {
	let anchor = $getNodeByKey(points.anchorKey);
	let focus = $getNodeByKey(points.focusKey);
	if (!anchor || !focus) return null;

	return createDOMRange(editor, anchor, points.anchorOffset, focus, points.focusOffset);
}

/**
 * Repaint every mark.
 *
 * Wholesale rather than incremental: the registry is small, the ranges are
 * invalidated by any edit anywhere, and a diff would be a second model of what
 * is on screen for no gain.
 */
export function paint(editor: LexicalEditor, marks: Marked[]): void {
	if (!available()) return fallback(editor, marks);

	let ranges = new Map<Tone, Range[]>();
	editor.getEditorState().read(() => {
		for (let mark of marks) {
			let range = $rangeOf(editor, mark.points);
			if (!range) continue;
			ranges.set(mark.tone, [...ranges.get(mark.tone) ?? [], range]);
		}
	});

	for (let [tone, name] of Object.entries(NAMES) as Array<[Tone, string]>) {
		let list = ranges.get(tone);
		if (!list || list.length === 0) CSS.highlights.delete(name);
		else CSS.highlights.set(name, new Highlight(...list));
	}
}

/** Take every mark down. Called when the editor goes away. */
export function clear(editor?: LexicalEditor): void {
	if (available()) {
		for (let name of Object.values(NAMES)) CSS.highlights.delete(name);
	}
	if (editor) outline(editor, []);
}

/** Blocks currently outlined by the fallback, so they can be un-outlined. */
const outlined = new WeakMap<LexicalEditor, string[]>();

function fallback(editor: LexicalEditor, marks: Marked[]): void {
	let keys: string[] = [];
	for (let mark of marks) {
		if (mark.tone === "decided") continue;
		for (let key of [mark.points.anchorKey, mark.points.focusKey]) {
			let block = blockOf(editor, key);
			if (block && !keys.includes(block)) keys.push(block);
		}
	}
	outline(editor, keys);
}

function blockOf(editor: LexicalEditor, key: string): string | undefined {
	let found: string | undefined;
	editor.getEditorState().read(() => {
		let node = $getNodeByKey(key);
		while (node) {
			let parent = node.getParent();
			if (!parent || parent.getKey() === "root") break;
			node = parent;
		}
		found = node?.getKey();
	});
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
