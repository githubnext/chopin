/**
 * The document on show follows its address's hash to a heading, as a page on GitHub does.
 *
 * A heading is told by the anchor Chopin gives it everywhere (`@chopin/dialect/heading-anchor`),
 * not by an element id: the editor draws its headings, and an id from a reader's words could
 * collide with one of the page's. So the hash is resolved here against the headings on show. A
 * followed link scrolls to its heading and marks it for a moment; Back returns to where the reader
 * was; arriving with a hash, from another document or a fresh load, goes there once the heading is
 * drawn. A hash that names no heading moves nothing.
 */

import { useEffect, useRef } from "react";
import { headingAnchors } from "@chopin/dialect/heading-anchor";

import { appLink, goToSection, LEAVING_PLACE, PLACE } from "./app-links";
import { motionImmediately } from "./motion-input";
import "./section-links.css";

import type { FollowLink } from "@chopin/editor/follow-link";
import type { RefObject } from "react";

/** How long an arriving hash waits for its heading to be drawn. */
const ARRIVAL_MS = 10_000;

/** Longer than the mark's fade, for a page where it never runs (reduced motion). */
const MARK_MS = 2_400;

/**
 * The app's own links for the editor's Open, its keyboard and a reader's tap, followed in place as
 * a click on one is: a section of this document by its hash, another page as Chat's links go.
 */
export const APP_LINKS: FollowLink = {
	owns: href => appLink(href, location) !== undefined,
	follow: href => {
		let destination = appLink(href, location);
		if (destination?.kind === "section") goToSection(destination.hash);
		else if (destination) {
			history.pushState(null, "", destination.path);
			dispatchEvent(new PopStateEvent("popstate"));
		}
	},
};

/** The top-level headings of a document root, with their anchors, in document order. */
export function sectionHeadings(
	root: ParentNode | null | undefined,
): Array<{ anchor: string; element: HTMLElement }> {
	let content = root?.querySelector<HTMLElement>(".plan-content");
	if (!content) return [];
	let elements = [...content.querySelectorAll<HTMLElement>(":scope > :is(h1, h2, h3, h4, h5, h6)")];
	let anchors = headingAnchors(elements.map(element => element.textContent ?? ""));
	return elements.map((element, index) => ({ anchor: anchors[index]!, element }));
}

/** The anchor a hash names: `#%C3%BCber-caf%C3%A9` and `#Über-Café` are both `über-café`. */
export function hashAnchor(hash: string): string {
	let raw = hash.replace(/^#/, "");
	try {
		raw = decodeURIComponent(raw);
	} catch {
		// A stray `%` names the text as written.
	}
	return raw.toLowerCase();
}

function placeOf(state: unknown): number | undefined {
	if (typeof state !== "object" || state === null) return undefined;
	let place = (state as Record<string, unknown>)[PLACE];
	return typeof place === "number" ? place : undefined;
}

export function useSectionLinks(
	{ area, reveal, room, root }: {
		/** Holds every document that can be on show; watched while an arriving hash waits. */
		area: RefObject<HTMLElement | null>;
		/** Bring the document view forward; true when it was not on show. */
		reveal: () => boolean;
		room: string;
		/** The document on show now. */
		root: () => ParentNode | null | undefined;
	},
): void {
	// The latest of each, so an earlier version coming and going is not a new arrival.
	let latest = useRef({ reveal, root });
	latest.current = { reveal, root };
	useEffect(() => {
		let root = () => latest.current.root();
		let reveal = () => latest.current.reveal();
		let marked: { element: HTMLElement; timer: number } | undefined;
		let frame = 0;
		let unmark = () => {
			if (!marked) return;
			window.clearTimeout(marked.timer);
			marked.element.removeAttribute("data-heading-linked");
			marked = undefined;
		};
		let scroller = () => root()?.querySelector<HTMLElement>("[data-plan-scroll]");

		/** Go to the heading `hash` names, if the document has it. */
		let go = (hash: string, smooth: boolean): boolean => {
			let anchor = hashAnchor(hash);
			if (!anchor) return false;
			let found = sectionHeadings(root()).find(heading => heading.anchor === anchor);
			if (!found) return false;
			let element = found.element;
			let shown = reveal();
			let move = () => {
				element.scrollIntoView({
					behavior: smooth && !shown && !motionImmediately() ? "smooth" : "auto",
					block: "start",
				});
				unmark();
				// Restarted, so a second click on the same link marks it again.
				element.removeAttribute("data-heading-linked");
				void element.offsetWidth;
				element.setAttribute("data-heading-linked", "");
				let timer = window.setTimeout(unmark, MARK_MS);
				marked = { element, timer };
			};
			cancelAnimationFrame(frame);
			// A view brought forward lays out in the next frame; scroll once it has.
			if (shown) frame = requestAnimationFrame(() => (frame = requestAnimationFrame(move)));
			else move();
			return true;
		};

		let observer: MutationObserver | undefined;
		let deadline = 0;
		let stopWaiting = () => {
			observer?.disconnect();
			observer = undefined;
			window.clearTimeout(deadline);
		};
		let leaving = () => {
			let top = scroller()?.scrollTop;
			if (top === undefined) return;
			let state: unknown = history.state;
			history.replaceState(
				{ ...(typeof state === "object" && state !== null ? state : {}), [PLACE]: top },
				"",
			);
		};
		let changed = () => {
			stopWaiting();
			if (go(location.hash, true)) return;
			if (location.hash) return;
			// Back to where a link was followed from.
			let place = placeOf(history.state);
			let element = scroller();
			if (place !== undefined && element) element.scrollTop = place;
		};

		// Arriving with a hash: go there as soon as the heading is drawn.
		if (location.hash && !go(location.hash, false) && area.current) {
			observer = new MutationObserver(() => {
				if (go(location.hash, false)) stopWaiting();
			});
			observer.observe(area.current, { characterData: true, childList: true, subtree: true });
			deadline = window.setTimeout(stopWaiting, ARRIVAL_MS);
		}

		// A plain click on a link to a section of this page anywhere on it (Chat, a decision card)
		// that nothing else took: the shell leaves these to the page, which loads this with it.
		let clicked = (event: MouseEvent) => {
			if (
				event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
				|| event.shiftKey || event.altKey || !(event.target instanceof Element)
			) return;
			let link = event.target.closest<HTMLAnchorElement>("a[href]");
			if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) {
				return;
			}
			let destination = appLink(link.href, location);
			if (destination?.kind !== "section") return;
			event.preventDefault();
			goToSection(destination.hash);
		};

		addEventListener(LEAVING_PLACE, leaving);
		addEventListener("hashchange", changed);
		document.addEventListener("click", clicked);
		return () => {
			document.removeEventListener("click", clicked);
			stopWaiting();
			cancelAnimationFrame(frame);
			unmark();
			removeEventListener(LEAVING_PLACE, leaving);
			removeEventListener("hashchange", changed);
		};
		// A new room is a new arrival.
	}, [area, room]);
}
