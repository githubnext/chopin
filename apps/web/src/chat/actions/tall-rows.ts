/**
 * Which messages of a transcript are too tall to show whole with their toolbar, which hangs above
 * a message's top: such a message has its bar kept in view as it scrolls (`message-toolbar.tsx`),
 * floating over its text as Slack's does, with nothing set aside for it. It is decided from the
 * message's size and the pane's, never from the pointer.
 *
 * One ResizeObserver serves a transcript and all its messages. With one per message, each message
 * read its own geometry and then wrote its attributes, so the next message's read laid the page out
 * again: opening a long Chat and every step of a pane drag laid it out once per message, and a row
 * that the drag leaves out of layout (`pane-drag-skip.ts`) was laid out again for the read. Here the
 * sizes are the observer's own, a message's toolbar is measured only when the message is near the
 * pane's height, and every read comes before any write.
 *
 * A message in a block a pane drag leaves out of layout is not decided while it is left out: reading
 * its toolbar's place laid that block out again for the read, once per such message on every step of
 * the drag, which on a Chat of long replies was most of the drag's cost. Its height does not change
 * while it is left out, and when the drag ends and it is laid out at its new width the observer gives
 * its new height, so it is decided then.
 */

export const TALL = "data-chat-tall";
/** The toolbar's own shift down a tall message, which `message-toolbar.tsx` writes. */
const SHIFT = "--chat-toolbar-shift";

/** A block a pane drag leaves out of layout (`pane-drag-skip.ts`). */
const SKIPPED = "[data-drag-skip]";

/** How far above its message a toolbar can hang, at most: its rise and the name line it clears. */
const MOST_HANG = 96;

type Transcript = {
	observer: ResizeObserver;
	/** Each message's border-box height, as the observer last gave it. */
	heights: Map<HTMLElement, number>;
};

let transcripts = new WeakMap<HTMLElement, Transcript>();

/** Whether a message of `height` with a toolbar hanging `hang` above it fits a pane of `pane`. */
export function isTall(height: number, hang: number, pane: number): boolean {
	return height + Math.max(0, hang) > pane;
}

function update(view: HTMLElement, transcript: Transcript, entries: ResizeObserverEntry[]) {
	let changed = new Set<HTMLElement>();
	let all = false;
	for (let entry of entries) {
		if (entry.target === view) {
			all = true;
			continue;
		}
		let element = entry.target as HTMLElement;
		if (!transcript.heights.has(element)) continue;
		transcript.heights.set(element, entry.borderBoxSize[0]?.blockSize ?? element.offsetHeight);
		changed.add(element);
	}
	let pane = view.clientHeight;
	let rows = (all ? [...transcript.heights.keys()] : [...changed]).filter(element =>
		!element.closest(SKIPPED)
	);
	// Reads first: the layout is current while nothing has been written.
	let decided = rows.map(element => {
		let height = transcript.heights.get(element)!;
		if (height + MOST_HANG <= pane) return { element, tall: false };
		let bar = element.querySelector<HTMLElement>(".chat-message-toolbar");
		let shift = Number.parseFloat(element.style.getPropertyValue(SHIFT)) || 0;
		let hang = bar
			? element.getBoundingClientRect().top - (bar.getBoundingClientRect().top - shift)
			: 0;
		return { element, tall: isTall(height, hang, pane) };
	});
	for (let { element, tall } of decided) {
		if (element.hasAttribute(TALL) !== tall) element.toggleAttribute(TALL, tall);
	}
}

/** Keep `element`'s `data-chat-tall` current while it is in `view`. */
export function watchTall(element: HTMLElement, view: HTMLElement): () => void {
	let transcript = transcripts.get(view);
	if (!transcript) {
		let made: Transcript = {
			heights: new Map(),
			observer: new ResizeObserver(entries => update(view, made, entries)),
		};
		made.observer.observe(view);
		transcripts.set(view, made);
		transcript = made;
	}
	let own = transcript;
	own.heights.set(element, 0);
	own.observer.observe(element);
	return () => {
		own.observer.unobserve(element);
		own.heights.delete(element);
		element.removeAttribute(TALL);
		if (own.heights.size === 0) {
			own.observer.disconnect();
			transcripts.delete(view);
		}
	};
}
