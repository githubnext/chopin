/**
 * Whether a block is within a screen of what the reader can see yet.
 *
 * A Mermaid drawing is expensive: the library is a large chunk, each diagram is laid out in a
 * hidden copy of the page, and the editable document is laid out again when it lands. Drawing every
 * diagram when the document opens made a long document with several of them busy for seconds
 * after it was on screen, for drawings nobody had scrolled to. They are drawn when they come within
 * a screen of the reader instead, from the scroller they sit in, and once drawn they stay drawn.
 *
 * The observer is a parameter so this can be tested without a browser. Where the browser has none,
 * every block counts as near: drawing too much beats a diagram that never arrives.
 */

import { type RefObject, useEffect, useState } from "react";

type Intersection = { isIntersecting: boolean };

type Observer = {
	observe(target: Element): void;
	disconnect(): void;
};

type ObserverConstructor = new(
	callback: (entries: Intersection[]) => void,
	options: { root: Element | null; rootMargin: string },
) => Observer;

/** A screen above and a screen below the scroller, and none to either side. */
export const NEAR_MARGIN = "100% 0px";

/**
 * Calls `onNear` once, the first time `target` is within a screen of `root`'s view, then stops
 * watching. Returns what ends the watch early.
 */
export function watchNear(
	target: Element,
	root: Element | null,
	onNear: () => void,
	Watcher: ObserverConstructor | undefined =
		(globalThis as { IntersectionObserver?: ObserverConstructor }).IntersectionObserver,
): () => void {
	if (!Watcher) {
		onNear();
		return () => {};
	}
	let done = false;
	let observer: Observer = new Watcher(entries => {
		if (done || !entries.some(entry => entry.isIntersecting)) return;
		done = true;
		observer.disconnect();
		onNear();
	}, { root, rootMargin: NEAR_MARGIN });
	observer.observe(target);
	return () => observer.disconnect();
}

/**
 * Tells `onPlaced` once whether `target` is within a screen of `root`'s view, the first time the
 * browser says, whichever it is, then stops watching. Returns what ends the watch early.
 */
export function watchPlaced(
	target: Element,
	root: Element | null,
	onPlaced: (near: boolean) => void,
	Watcher: ObserverConstructor | undefined =
		(globalThis as { IntersectionObserver?: ObserverConstructor }).IntersectionObserver,
): () => void {
	if (!Watcher) {
		onPlaced(true);
		return () => {};
	}
	let done = false;
	let observer: Observer = new Watcher(entries => {
		let latest = entries.at(-1);
		if (done || !latest) return;
		done = true;
		observer.disconnect();
		onPlaced(latest.isIntersecting);
	}, { root, rootMargin: NEAR_MARGIN });
	observer.observe(target);
	return () => observer.disconnect();
}

/**
 * Whether the element was within a screen of the reader when it mounted: undefined until the
 * browser first says, a frame later, then fixed for as long as it stays mounted. A block that
 * mounts again is placed again.
 */
export function useNearAtMount(ref: RefObject<HTMLElement | null>): boolean | undefined {
	let [near, setNear] = useState<boolean>();
	useEffect(() => {
		let element = ref.current;
		if (!element) return;
		return watchPlaced(element, element.closest("[data-plan-scroll]"), setNear);
	}, [ref]);
	return near;
}

/** True from the first time the block is near, for as long as the caller keeps asking. */
export function useNearViewport(
	element: HTMLElement | null | undefined,
	enabled: boolean,
): boolean {
	let [near, setNear] = useState(false);
	useEffect(() => {
		if (near || !enabled || !element) return;
		return watchNear(element, element.closest("[data-plan-scroll]"), () => setNear(true));
	}, [near, enabled, element]);
	return near;
}
