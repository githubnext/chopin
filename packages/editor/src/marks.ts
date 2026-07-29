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
 * Asking to be taken somewhere is a second kind of pointing, and it outlives
 * the pointer. A reader who clicks a card is sent where they were not looking,
 * so a mark that went out the moment the mouse left the card would land them
 * on a block with nothing to say which one it was. That is the pin: the same
 * wash, held for a few seconds after the pointer has gone.
 *
 * There is one pin, not one per store, for the same reason the registry is
 * shared: a reader has one pointer, so going to a comment has to put out the
 * question they went to before it.
 *
 * A hover outranks the pin rather than joining it. Two washes at once cannot
 * say which one the reader was sent to, and pointing at a second card is a
 * question about that card — so it borrows the wash and gives it back, which
 * is what makes a detour a detour rather than a new destination.
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

/**
 * How long a pin stays up.
 *
 * The same five seconds an agent's mark gets, and for the same reason: long
 * enough to land an eye, short of becoming a standing mark. It only ever runs
 * down once the pointer has left the card, because a hover outranks the pin —
 * which is exactly the moment the number has to be right for.
 */
const LINGER = 5_000;

/** What each store wants marked, most recently declared. */
const wanted = new Map<Owner, Points[]>();

/** Where the reader asked to be taken, until it lapses. */
let pinned: { owner: Owner; places: Points[] } | undefined;
let lapsing: ReturnType<typeof setTimeout> | undefined;

/**
 * Everything to paint.
 *
 * Pure, and exported for that reason: whether two stores can coexist in one
 * registry, and whether a hover can borrow the wash from a pin without losing
 * it, are the parts of this worth testing and the parts that need no browser.
 */
export function union(): Points[] {
	let hover = [...wanted.values()].flat();
	return hover.length > 0 ? hover : pinned?.places ?? [];
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
		render(editor);
	} catch (err) {
		// This is reached from a Lexical update listener, and Lexical runs
		// those in one unisolated loop — a throw here would skip the listener
		// that syncs the document. Losing a highlight is the cheapest possible
		// outcome and the only acceptable one.
		console.error("[plan] could not mark prose:", err);
	}
}

/**
 * Hold a mark on where the reader asked to be taken.
 *
 * Replaces whatever was pinned, whoever pinned it, and restarts the clock —
 * so walking from one place to the next keeps the pin alive for as long as
 * somebody is walking.
 *
 * The places are node keys, taken once and not re-resolved. A block rewritten
 * inside the five seconds leaves a key that names nothing, and the mark goes
 * out early — which is what a lapse looks like anyway, and cheaper than a
 * second subscription to the document for a mark this short-lived. Keys are
 * never reused, so the failure can only ever be no mark, not a wrong one.
 *
 * `linger` is an argument rather than a constant for the reason `trail.ts`
 * gives: the test runtime has no controllable clock, so the only way to watch
 * a pin lapse is to ask for a short one.
 */
export function pin(
	editor: LexicalEditor,
	owner: Owner,
	places: Points[],
	linger = LINGER,
): void {
	try {
		if (lapsing !== undefined) clearTimeout(lapsing);
		pinned = { owner, places };
		lapsing = setTimeout(() => {
			lapsing = undefined;
			pinned = undefined;
			// Guarded again: this runs on a timer, outside every call the
			// editor makes, so nothing above it would catch a throw.
			try {
				render(editor);
			} catch (err) {
				console.error("[plan] could not take a mark down:", err);
			}
		}, linger);
		render(editor);
	} catch (err) {
		console.error("[plan] could not mark prose:", err);
	}
}

/**
 * Whether the pin is currently this store's.
 *
 * Asked rather than announced. The only thing that depends on a pin having
 * lapsed is the next click on the card that set it — nothing has to be redrawn,
 * because the lapse redraws itself — and a callback fired on the way to
 * replacing a pin would reach a store in the middle of walking and wipe the
 * step it had just taken.
 */
export function holds(owner: Owner): boolean {
	return pinned?.owner === owner;
}

/** Drop the pin, if it is the caller's to drop. */
export function unpin(editor?: LexicalEditor, owner?: Owner): void {
	if (owner !== undefined && !holds(owner)) return;
	release();
	if (editor) {
		try {
			render(editor);
		} catch (err) {
			console.error("[plan] could not take a mark down:", err);
		}
	}
}

/** Take every mark down, pin included. Called when the editor goes away. */
export function clear(editor?: LexicalEditor): void {
	wanted.clear();
	release();
	if (available()) CSS.highlights.delete(NAME);
	if (editor) outline(editor, []);
}

function release(): void {
	if (lapsing !== undefined) clearTimeout(lapsing);
	lapsing = undefined;
	pinned = undefined;
}

/** Write the union to the registry. Throws; every caller guards. */
function render(editor: LexicalEditor): void {
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
