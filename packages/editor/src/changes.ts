/**
 * Showing the reader what the agent just did to the plan.
 *
 * The server says what a batch wrote, moved and took out; this puts each of
 * those somewhere on screen, and holds it back until the reader has actually
 * reached it. Everything is drawn by attribute on a block that already exists,
 * so the marks add no element and take no space — an agent editing below the
 * fold must not shift the sentence somebody is in the middle of typing, and a
 * mark that expires ten seconds later must not shift it back.
 *
 * A block that has gone cannot carry a mark, so a hole is drawn on the edge of
 * the block still beside it and the side is part of the address. That is also
 * why a hole can only ever say that something was here: what it was lives in
 * the list behind the chips, which is the one place a removal can be read
 * after the fact.
 *
 * Nothing is written into the document. These are one reader's marks, arriving
 * at a different moment for everybody in the room, and putting them in the
 * document would send them to everyone else and make them undoable.
 */

import { resolve } from "./anchors";
import { trail } from "./trail";

import type { Binding } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { Plan } from "@chopin/protocol";
import type { Trail } from "./trail";

/**
 * How far into the viewport a block has to come to count as seen.
 *
 * An inset on the root rather than a ratio of the element: `threshold` is a
 * fraction of the observed block, so a code block taller than the window could
 * never reach one and would stay unread however long it was looked at.
 */
const MARGIN = 24;

/** Which of the four marks a placement draws. */
export type Kind = "added" | "moved" | "removed" | "vacated";

/** One end of a change, resolved to somewhere in this editor. */
type Placement = {
	id: string;
	change: string;
	kind: Kind;
	anchor: Plan.Anchor;
	/** Which edge of the anchored block, for the two that draw a hole. */
	side?: "before" | "after";
};

/** A change, as the list behind the chips shows it. */
export type Entry = {
	id: string;
	kind: Plan.Change["kind"];
	/** What was written, or what was taken out. */
	blocks: Plan.Excerpt[];
	/** Whether the reader has been shown it yet. */
	seen: boolean;
};

export type Snapshot = {
	entries: Entry[];
	/** Unseen marks the reader would have to scroll up to reach. */
	above: number;
	/** Unseen marks below the fold. */
	below: number;
};

const EMPTY: Snapshot = { entries: [], above: 0, below: 0 };

function attribute(placement: Placement): string {
	return placement.kind === "added" || placement.kind === "moved"
		? "data-plan-change"
		: `data-plan-gap-${placement.side ?? "before"}`;
}

function value(placement: Placement): string {
	return placement.kind;
}

export class ChangeStore {
	#listeners = new Set<() => void>();
	#snapshot: Snapshot = EMPTY;

	#editor: LexicalEditor | undefined;
	#binding: Binding | undefined;
	#scroller: HTMLElement | undefined;

	#changes = new Map<string, Plan.Change>();
	#placements = new Map<string, Placement>();
	#marks: Trail = trail(() => this.refresh());
	#counter = 0;

	/** Which way out of view each unseen mark is, from the last time it moved. */
	#side = new Map<string, "above" | "below">();

	#observer: IntersectionObserver | undefined;
	/** What each observed element currently stands for. */
	#observed = new Map<Element, Set<string>>();
	/** Attributes this store put on the document, so it can take them off. */
	#painted = new Map<HTMLElement, Set<string>>();

	#scrolled = 0;
	#frame = 0;

	subscribe = (listener: () => void): () => void => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	snapshot = (): Snapshot => this.#snapshot;

	// -- attachment ----------------------------------------------------------

	/** The editor, so a node key can be turned into something on screen. */
	attach(editor: LexicalEditor | undefined): void {
		if (this.#editor && this.#editor !== editor) this.clear();
		this.#editor = editor;
	}

	/** The Yjs binding, so a relative position can be turned into a node key. */
	bind(binding: Binding | undefined): void {
		this.#binding = binding;
	}

	/**
	 * The element the plan scrolls in, which is what "in view" is measured
	 * against. The pane around it is the wrong frame: it does not scroll.
	 */
	viewport(element: HTMLElement | undefined): void {
		if (this.#scroller === element) return;
		this.#scroller = element;
		this.#observer?.disconnect();
		this.#observer = undefined;
		this.#observed.clear();
		this.refresh();
	}

	// -- what the agent did --------------------------------------------------

	/**
	 * Take on a batch.
	 *
	 * A move arrives as one change with two ends, and stays one entry in the
	 * list: shown as a disappearance and an arrival, a reader would have to
	 * work out for themselves that they were the same block.
	 */
	mark(changes: Plan.Change[]): void {
		for (let change of changes) {
			let id = `c${this.#counter++}`;
			this.#changes.set(id, change);

			let ends: Placement[] = [];
			if (change.kind === "removed") {
				ends.push({
					id: `${id}:at`,
					change: id,
					kind: "removed",
					anchor: change.at.at,
					side: change.at.side,
				});
			} else {
				ends.push({ id: `${id}:at`, change: id, kind: change.kind, anchor: change.at });
				if (change.kind === "moved") {
					ends.push({
						id: `${id}:from`,
						change: id,
						kind: "vacated",
						anchor: change.from.at,
						side: change.from.side,
					});
				}
			}

			for (let end of ends) this.#placements.set(end.id, end);
			this.#marks.add(ends.map(end => end.id));
		}

		this.refresh();
	}

	/** Forget everything. The epoch rotated, or the editor went away. */
	clear(): void {
		this.#marks.dispose();
		this.#marks = trail(() => this.refresh());
		this.#changes.clear();
		this.#placements.clear();
		this.#side.clear();
		this.#unpaint();
		this.#observer?.disconnect();
		this.#observer = undefined;
		this.#observed.clear();
		this.#publish(EMPTY);
	}

	dispose(): void {
		this.clear();
		this.#marks.dispose();
		if (this.#frame) cancelAnimationFrame(this.#frame);
		this.#frame = 0;
	}

	// -- painting ------------------------------------------------------------

	/**
	 * Resolve every mark against the document as it is now, and paint.
	 *
	 * Re-resolved on every pass rather than once on arrival: a relative
	 * position survives edits around it, so re-resolving is what keeps a mark
	 * on the right block while somebody types above it. Elements are looked up
	 * again for the same reason — Lexical rebuilds a block's element when the
	 * block changes, and an attribute set on the old one goes with it.
	 *
	 * Guarded whole. This runs from a Lexical update listener, and Lexical runs
	 * those in one loop with no isolation: a throw here would skip the listener
	 * that syncs the document, and the room would lose edits over a highlight.
	 */
	refresh = (): void => {
		try {
			this.#resolve();
		} catch (err) {
			console.error("[plan] could not mark what the agent changed:", err);
		}
	};

	#resolve(): void {
		let editor = this.#editor;
		let binding = this.#binding;
		if (!editor || !binding) return;

		// Called from a Lexical update listener, so this runs on every
		// keystroke in the plan and almost none of them concern a mark.
		if (this.#placements.size === 0 && this.#painted.size === 0) return;

		// A mark that expired on its own left its placement behind: the trail
		// owns the lifetime and has no way to reach in here when a timer runs
		// out, so what it has forgotten is collected on the next pass.
		this.#prune();

		let elements = new Map<string, HTMLElement>();
		let gone: string[] = [];

		for (let placement of this.#placements.values()) {
			if (!this.#marks.phase(placement.id)) continue;

			let key = resolve(binding, placement.anchor);
			if (!key) {
				// The block it named is gone. Told apart from a block that
				// simply has not been painted yet, below, because that one
				// resolves to a key and only wants another pass.
				gone.push(placement.id);
				continue;
			}

			let element = editor.getElementByKey(key);
			if (element) elements.set(placement.id, element);
		}

		if (gone.length > 0) this.#marks.drop(gone);
		this.#observe(elements);
		this.#paint(elements);
		this.#publish(this.#describe(elements));
	}

	/** Watch what is on screen, so a mark can wait until it has been read. */
	#observe(elements: Map<string, HTMLElement>): void {
		let root = this.#scroller;
		if (!root || typeof IntersectionObserver === "undefined") {
			// No way to tell what is in view, so nothing can be held back.
			// Over-showing beats marks that would never appear at all.
			this.#marks.saw(elements.keys());
			return;
		}

		this.#observer ??= new IntersectionObserver(entries => this.#sighted(entries), {
			root,
			rootMargin: `-${MARGIN}px 0px`,
		});

		let wanted = new Map<Element, Set<string>>();
		for (let [id, element] of elements) {
			let ids = wanted.get(element) ?? new Set();
			ids.add(id);
			wanted.set(element, ids);
		}

		for (let element of this.#observed.keys()) {
			if (!wanted.has(element)) this.#observer.unobserve(element);
		}
		for (let element of wanted.keys()) {
			if (!this.#observed.has(element)) this.#observer.observe(element);
		}
		this.#observed = wanted;
	}

	#sighted(entries: IntersectionObserverEntry[]): void {
		let seen: string[] = [];

		for (let entry of entries) {
			let ids = this.#observed.get(entry.target);
			if (!ids) continue;

			if (entry.isIntersecting) {
				for (let id of ids) seen.push(id);
				continue;
			}

			// Which way it went. An unseen mark cannot change side without
			// crossing the viewport, and crossing produces an entry, so this
			// stays true without watching the scroll — except across a jump
			// that skips the viewport entirely, which `#jumped` picks up.
			let top = entry.rootBounds?.top ?? 0;
			let side: "above" | "below" = entry.boundingClientRect.bottom <= top ? "above" : "below";
			for (let id of ids) this.#side.set(id, side);
		}

		if (seen.length > 0) this.#marks.saw(seen);
		this.refresh();
	}

	/**
	 * Recheck which way out of view everything is.
	 *
	 * Only worth doing after a jump: an element that leaves one edge of the
	 * viewport and arrives past the other within a single frame is never
	 * intersecting at either end, so the observer has nothing to report and
	 * the side it was last seen on is stale.
	 */
	onScroll = (): void => {
		let root = this.#scroller;
		if (!root) return;

		let moved = Math.abs(root.scrollTop - this.#scrolled);
		this.#scrolled = root.scrollTop;
		if (moved <= root.clientHeight) return;

		if (this.#frame) cancelAnimationFrame(this.#frame);
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			this.#jumped();
		});
	};

	#jumped(): void {
		let root = this.#scroller;
		if (!root) return;

		let bounds = root.getBoundingClientRect();
		for (let [element, ids] of this.#observed) {
			let rect = element.getBoundingClientRect();
			if (rect.bottom > bounds.top && rect.top < bounds.bottom) continue;
			let side: "above" | "below" = rect.bottom <= bounds.top ? "above" : "below";
			for (let id of ids) this.#side.set(id, side);
		}
		this.refresh();
	}

	#paint(elements: Map<string, HTMLElement>): void {
		let next = new Map<HTMLElement, Set<string>>();

		for (let id of this.#marks.showing()) {
			let placement = this.#placements.get(id);
			let element = elements.get(id);
			if (!placement || !element) continue;

			let names = next.get(element) ?? new Set();
			names.add(attribute(placement));
			next.set(element, names);
			element.setAttribute(attribute(placement), value(placement));
		}

		for (let [element, names] of this.#painted) {
			for (let name of names) {
				if (!next.get(element)?.has(name)) element.removeAttribute(name);
			}
		}
		this.#painted = next;
	}

	#unpaint(): void {
		for (let [element, names] of this.#painted) {
			for (let name of names) element.removeAttribute(name);
		}
		this.#painted.clear();
	}

	// -- what the chips say --------------------------------------------------

	#describe(elements: Map<string, HTMLElement>): Snapshot {
		let above = 0;
		let below = 0;

		for (let id of this.#marks.pending()) {
			// Only what can actually be reached is worth counting. A mark whose
			// block has not been painted yet is not somewhere to send anyone.
			if (!elements.has(id)) continue;
			if (this.#side.get(id) === "above") above++;
			else below++;
		}

		// A move has two ends, and reaching either of them is having been shown
		// the change — so this is worked out per change rather than per end.
		let shown = new Set<string>();
		for (let id of this.#marks.showing()) {
			let placement = this.#placements.get(id);
			if (placement) shown.add(placement.change);
		}

		let entries: Entry[] = [];
		let listed = new Set<string>();
		for (let id of this.#marks.ids()) {
			let placement = this.#placements.get(id);
			if (!placement || listed.has(placement.change)) continue;
			let change = this.#changes.get(placement.change);
			if (!change) continue;

			listed.add(placement.change);
			entries.push({
				id: placement.change,
				kind: change.kind,
				blocks: change.kind === "removed"
					? change.blocks
					: [{ type: change.type, preview: change.preview }],
				seen: shown.has(placement.change),
			});
		}

		return { entries, above, below };
	}

	#publish(snapshot: Snapshot): void {
		let same = snapshot.above === this.#snapshot.above
			&& snapshot.below === this.#snapshot.below
			&& JSON.stringify(snapshot.entries) === JSON.stringify(this.#snapshot.entries);
		if (same) return;

		this.#snapshot = snapshot;
		for (let listener of this.#listeners) listener();
	}

	/** Drop changes no end of which is still being tracked. */
	#prune(): void {
		let live = new Set<string>();
		for (let id of this.#marks.ids()) {
			let placement = this.#placements.get(id);
			if (placement) live.add(placement.change);
		}
		for (let id of this.#placements.keys()) {
			if (!this.#marks.phase(id)) this.#placements.delete(id);
		}
		for (let id of this.#changes.keys()) {
			if (!live.has(id)) this.#changes.delete(id);
		}
	}

	// -- going to one --------------------------------------------------------

	/** Scroll to the nearest unseen mark in one direction, which reveals it. */
	reveal(direction: "above" | "below"): void {
		let root = this.#scroller;
		if (!root) return;

		let bounds = root.getBoundingClientRect();
		let best: { element: Element; distance: number } | undefined;

		for (let id of this.#marks.pending()) {
			if ((this.#side.get(id) ?? "below") !== direction) continue;

			for (let [element, ids] of this.#observed) {
				if (!ids.has(id)) continue;
				let rect = element.getBoundingClientRect();
				let distance = direction === "above"
					? bounds.top - rect.bottom
					: rect.top - bounds.bottom;
				if (!best || distance < best.distance) best = { element, distance };
			}
		}

		best?.element.scrollIntoView({
			block: "center",
			// A scroll behaviour set in script is out of the stylesheet's
			// reach, so the reduced-motion preference has to be read here.
			behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
		});
	}
}
