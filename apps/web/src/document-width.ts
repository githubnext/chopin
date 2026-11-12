import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import "./document-width.css";

import type { RefObject } from "react";

/** The view transition's name for the document's scroller while its column moves. */
export const DOCUMENT_COLUMN = "document-column";

/** Where the reader is: the first block of the shown document that reaches below its top edge. */
export type ReaderPlace = { block: Element; offset: number };

/** The first of the boxes, in order, whose bottom is below `edge`. */
export function placeIndex(boxes: readonly { top: number; bottom: number }[], edge: number) {
	return boxes.findIndex(box => box.bottom > edge);
}

/** The column's edges inside its scroller, as a clip that leaves only the column showing. */
export function columnClip(
	scroller: { left: number; right: number },
	column: { left: number; right: number },
): string {
	let start = Math.max(0, Math.round(column.left - scroller.left));
	let end = Math.max(0, Math.round(scroller.right - column.right));
	return `inset(0 ${end}px 0 ${start}px)`;
}

function shownScroller(area: HTMLElement): HTMLElement | undefined {
	return [...area.querySelectorAll<HTMLElement>("[data-plan-scroll]")].find(scroller =>
		scroller.clientHeight > 0
	);
}

function readerPlace(scroller: HTMLElement): ReaderPlace | undefined {
	let blocks = [...scroller.querySelectorAll(".plan-content > *")];
	let edge = scroller.getBoundingClientRect().top;
	let boxes = blocks.map(block => block.getBoundingClientRect());
	let index = placeIndex(boxes, edge);
	if (index < 0) return undefined;
	return { block: blocks[index]!, offset: boxes[index]!.top - edge };
}

/** Scrolls so the block the reader was at is where it was, however the text above rewrapped. */
function keepPlace(scroller: HTMLElement, place: ReaderPlace): void {
	if (!place.block.isConnected) return;
	let moved = place.block.getBoundingClientRect().top - scroller.getBoundingClientRect().top
		- place.offset;
	if (Math.abs(moved) >= 0.5) scroller.scrollTop += moved;
}

function clipOf(scroller: HTMLElement): string {
	let column = scroller.querySelector(".plan-content") ?? scroller;
	return columnClip(scroller.getBoundingClientRect(), column.getBoundingClientRect());
}

/**
 * The width a document's area shows (`document-width.css` reads it from the area's
 * `data-document-width`), and the one moment of motion when it changes.
 *
 * The page is laid out once at the new width, never on every frame: a view transition then shows
 * the column's edges gliding from where they were to where they are while the text crossfades from
 * its old lines to its new ones, drawn from two pictures of the document. The block at the top of
 * the reader's view stays where it was. Under reduced motion, or where the browser has no view
 * transitions, the width snaps. Chat is outside the document and never reflows.
 */
export function useDocumentWidth(area: RefObject<HTMLElement | null>, full: boolean): boolean {
	let [shown, setShown] = useState(full);
	let running = useRef<ViewTransition>(undefined);
	let target = useRef(full);
	target.current = full;
	/** Keeps the reader's place once a snapped width has been laid out. */
	let snapped = useRef<() => void>(undefined);

	useLayoutEffect(() => {
		if (full === shown) return;
		running.current?.skipTransition();
		let element = area.current;
		let scroller = element ? shownScroller(element) : undefined;
		let place = scroller ? readerPlace(scroller) : undefined;
		let keep = () => {
			if (scroller && place) keepPlace(scroller, place);
		};
		if (
			!scroller || !document.startViewTransition
			|| matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			snapped.current = keep;
			setShown(full);
			return;
		}
		let root = document.documentElement.style;
		root.setProperty("--document-column-from", clipOf(scroller));
		root.setProperty("--document-column-to", clipOf(scroller));
		scroller.style.viewTransitionName = DOCUMENT_COLUMN;
		// An open menu is drawn above the document's pictures, as it is above the document.
		let menus = [...document.querySelectorAll<HTMLElement>("[role=menu]")];
		for (let [index, menu] of menus.entries()) {
			menu.style.viewTransitionName = `document-menu-${index}`;
		}
		let transition = document.startViewTransition(() => {
			// The latest wish when the old picture has been taken, which a quick second press changes.
			flushSync(() => setShown(target.current));
			keep();
			root.setProperty("--document-column-to", clipOf(scroller));
		});
		running.current = transition;
		void transition.finished.finally(() => {
			if (running.current !== transition) return;
			running.current = undefined;
			for (let named of [scroller, ...menus]) {
				named.style.removeProperty("view-transition-name");
				if (!named.getAttribute("style")) named.removeAttribute("style");
			}
			root.removeProperty("--document-column-from");
			root.removeProperty("--document-column-to");
		});
	}, [area, full, shown]);

	useLayoutEffect(() => {
		snapped.current?.();
		snapped.current = undefined;
	}, [shown]);

	return shown;
}
