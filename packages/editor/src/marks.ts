/**
 * Marking the prose a sidecar card refers to.
 *
 * Through the CSS Custom Highlight API, which is what Lexical already uses for
 * remote selections. Ranges live in a document-wide registry keyed by name and
 * are styled by `::highlight()` rules, so nothing is inserted into the tree:
 * the dialect has no mark node, and adding one would put one reader's pointer
 * into everybody's document and make it undoable.
 *
 * Decisions mark prose only while somebody is pointing at the card that owns
 * them. Standing decision marks were tried and taken out again: a plan
 * accumulates decisions, so anything painted permanently ends up painted over
 * most of the prose. Open comments are the exception, because resolving one
 * takes its wash away: a faint amber at rest, stronger while pointed at, and
 * underlined while its card is open (`paintComments`).
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
export type Owner = "questions" | "comments" | "decisions";

const NAME = "plan-related";
/** Where a reader was sent to a comment's passage: the comment's own strong wash. */
const COMMENT_PIN = "plan-comment-pin";
const DECIDED = "plan-decided";

/** CSS Highlights is document-wide, so each mounted editor owns only its ranges. */
const decided = new Map<LexicalEditor, Range[]>();

export function decidedRanges(): Range[] {
	return [...decided.values()].flat();
}

/** Replace one editor's decided ranges and publish the union. */
export function paintDecided(editor: LexicalEditor, ranges: Range[]): void {
	if (ranges.length === 0) decided.delete(editor);
	else decided.set(editor, ranges);
	if (!available()) return;
	let all = decidedRanges();
	if (all.length === 0) CSS.highlights.delete(DECIDED);
	else CSS.highlights.set(DECIDED, new Highlight(...all));
}
/**
 * Named highlights painted by more than one editor.
 *
 * `CSS.highlights` is document-wide, so a parent and a child editor each own
 * their ranges here and every write publishes the union for that name.
 */
const shared = new Map<string, Map<LexicalEditor, Range[]>>();

/** Replace one editor's ranges under a shared name and publish the union. */
export function paintShared(name: string, editor: LexicalEditor, ranges: Range[]): void {
	let owners = shared.get(name) ?? new Map<LexicalEditor, Range[]>();
	if (ranges.length === 0) owners.delete(editor);
	else owners.set(editor, ranges);
	if (owners.size === 0) shared.delete(name);
	else shared.set(name, owners);
	if (!available()) return;
	let all = [...owners.values()].flat();
	if (all.length === 0) CSS.highlights.delete(name);
	else CSS.highlights.set(name, new Highlight(...all));
}

/**
 * How strongly a commented passage is being pointed at.
 *
 * Every open thread's passage carries a faint wash at rest. Pointing at the
 * passage or its margin chip strengthens it, and an open card adds an
 * underline. Each passage is painted under exactly one name, so the tones
 * never stack into a darker fourth.
 */
export type CommentTone = "rest" | "hover" | "open";

export const COMMENT_HIGHLIGHT: { [tone in CommentTone]: string } = {
	rest: "plan-comment",
	hover: "plan-comment-hover",
	open: "plan-comment-open",
};

/** What each editor asked to have washed, before any DOM range is built. */
const commentTones = new Map<LexicalEditor, { [tone in CommentTone]?: Points[] }>();

/** Every commented passage asked for, by tone. Pure, so it is testable headless. */
export function commented(): { [tone in CommentTone]: Points[] } {
	let out: { [tone in CommentTone]: Points[] } = { rest: [], hover: [], open: [] };
	for (let tones of commentTones.values()) {
		for (let tone of ["rest", "hover", "open"] as const) out[tone].push(...(tones[tone] ?? []));
	}
	return out;
}

/** Paint one editor's commented passages by tone. */
export function paintComments(
	editor: LexicalEditor,
	tones: { [tone in CommentTone]?: Points[] },
): void {
	commentTones.set(editor, tones);
	try {
		let ranges: { [tone in CommentTone]: Range[] } = { rest: [], hover: [], open: [] };
		editor.getEditorState().read(() => {
			for (let tone of ["rest", "hover", "open"] as const) {
				for (let points of tones[tone] ?? []) {
					let range = $rangeOf(editor, points);
					if (range) ranges[tone].push(range);
				}
			}
		});
		for (let tone of ["rest", "hover", "open"] as const) {
			paintShared(COMMENT_HIGHLIGHT[tone], editor, ranges[tone]);
		}
	} catch (err) {
		// Reached from a Lexical update listener; see `paint`.
		console.error("[plan] could not mark commented prose:", err);
	}
}

/** Prose a decision produced is washed in the decision's own (success) tone. */
const DECISION_NAME = "plan-decision";

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
const wanted = new Map<LexicalEditor, Map<Owner, Points[]>>();

/** Where the reader asked to be taken, until it lapses. */
let pinned: { editor: LexicalEditor; owner: Owner; places: Points[] } | undefined;
let lapsing: ReturnType<typeof setTimeout> | undefined;

/**
 * Everything to paint.
 *
 * Pure, and exported for that reason: whether two stores can coexist in one
 * registry, and whether a hover can borrow the wash from a pin without losing
 * it, are the parts of this worth testing and the parts that need no browser.
 */
export function union(): Points[] {
	return layers().flatMap(([, , places]) => places);
}

/** `union`, still divided by the store that asked, so each can keep its own tone. */
function layers(): [LexicalEditor, Owner, Points[]][] {
	let hover = [...wanted].flatMap(([editor, owners]) =>
		[...owners].filter(([, places]) => places.length > 0)
			.map(([owner, places]): [LexicalEditor, Owner, Points[]] => [editor, owner, places])
	);
	if (hover.length > 0) return hover;
	return pinned ? [[pinned.editor, pinned.owner, pinned.places]] : [];
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
		if (owner === "decisions") {
			let ranges: Range[] = [];
			editor.getEditorState().read(() => {
				for (let points of places) {
					let range = $rangeOf(editor, points);
					if (range) ranges.push(range);
				}
			});
			paintDecided(editor, ranges);
			return;
		}
		let owners = wanted.get(editor) ?? new Map<Owner, Points[]>();
		if (places.length > 0) owners.set(owner, places);
		else owners.delete(owner);
		if (owners.size > 0) wanted.set(editor, owners);
		else wanted.delete(editor);
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
	if (owner === "decisions") return;
	try {
		if (lapsing !== undefined) clearTimeout(lapsing);
		pinned = { editor, owner, places };
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
 * Whether the pin is currently this store's. A bound editor also checks which
 * mounted surface owns it, so another surface's pin cannot continue a local walk.
 *
 * Asked rather than announced. The only thing that depends on a pin having
 * lapsed is the next click on the card that set it — nothing has to be redrawn,
 * because the lapse redraws itself — and a callback fired on the way to
 * replacing a pin would reach a store in the middle of walking and wipe the
 * step it had just taken.
 */
export function holds(owner: Owner, editor?: LexicalEditor): boolean {
	return pinned?.owner === owner && (editor === undefined || pinned.editor === editor);
}

/** Drop the pin, if it is the caller's to drop. */
export function unpin(editor?: LexicalEditor, owner?: Owner): void {
	if (editor !== undefined && pinned?.editor !== editor) return;
	if (owner !== undefined && (editor === undefined || !holds(owner, editor))) return;
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
	if (editor) {
		wanted.delete(editor);
		if (pinned?.editor === editor) release();
		paintDecided(editor, []);
		for (let name of shared.keys()) paintShared(name, editor, []);
		commentTones.delete(editor);
		outline(editor, []);
		try {
			render(editor);
		} catch (error) {
			console.error("[plan] could not take a mark down:", error);
		}
	} else {
		wanted.clear();
		release();
		decided.clear();
		let names = [...shared.keys()];
		shared.clear();
		commentTones.clear();
		if (available()) {
			CSS.highlights.delete(NAME);
			CSS.highlights.delete(DECISION_NAME);
			CSS.highlights.delete(DECIDED);
			CSS.highlights.delete(COMMENT_PIN);
			for (let name of names) CSS.highlights.delete(name);
		}
	}
}

function release(): void {
	if (lapsing !== undefined) clearTimeout(lapsing);
	lapsing = undefined;
	pinned = undefined;
}

/** Write the union to the registry. Throws; every caller guards. */
function render(editor: LexicalEditor): void {
	if (!available()) return fallback(editor);

	let ranges: { [name: string]: Range[] } = { [NAME]: [], [DECISION_NAME]: [], [COMMENT_PIN]: [] };
	let named = (owner: Owner) =>
		owner === "questions" ? DECISION_NAME : owner === "comments" ? COMMENT_PIN : NAME;
	for (let [source, owner, places] of layers()) {
		source.getEditorState().read(() => {
			for (let points of places) {
				let range = $rangeOf(source, points);
				if (range) ranges[named(owner)]!.push(range);
			}
		});
	}

	for (let [name, found] of Object.entries(ranges)) {
		if (found.length === 0) CSS.highlights.delete(name);
		else CSS.highlights.set(name, new Highlight(...found));
	}
}

/** Blocks currently outlined by the fallback, so they can be un-outlined. */
const outlined = new WeakMap<LexicalEditor, string[]>();

function fallback(editor: LexicalEditor): void {
	let keys: string[] = [];
	for (
		let points of layers().filter(([source]) => source === editor)
			.flatMap(([, , places]) => places)
	) {
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
