import { useLayoutEffect } from "react";

import { currentViewport, listenToViewportChanges } from "@chopin/viewport";

import { commentRevealScroll } from "./comment-reveal";
import { commentSheetTop } from "./comment-sheet";
import { planScroller } from "./scroll";

import type { Rect } from "./comment-geometry";

/**
 * Keep a compact comment's passage above its sheet, then return the reader on close.
 *
 * The sheet is as tall as its content and rises with the keyboard, so the
 * passage is placed again whenever either changes, from where it is now.
 */
export function useCommentSheetReveal({
	host,
	id,
	passages,
	sheet,
}: {
	host: HTMLElement | undefined;
	id: string | undefined;
	passages: Rect[] | undefined;
	/** The sheet's surface, which mounts a frame after the comment opens. */
	sheet: HTMLElement | null;
}) {
	useLayoutEffect(() => {
		if (!host || !id) return;
		let scroller = planScroller(host);
		if (!scroller) return;
		let top = scroller.scrollTop;
		return () => {
			if (scroller.isConnected) scroller.scrollTop = top;
		};
	}, [host, id]);

	useLayoutEffect(() => {
		if (!host || !id || !sheet || !passages || passages.length === 0) return;
		let scroller = planScroller(host);
		if (!scroller) return;
		// Passages are measured relative to the scroll position they were taken at.
		let measuredAt = scroller.scrollTop;
		let frame = 0;
		let reveal = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (!scroller.isConnected || !sheet.isConnected) return;
				let viewport = currentViewport();
				let keyboard = Math.max(0, window.innerHeight - viewport.top - viewport.height);
				let shift = scroller.scrollTop - measuredAt;
				let next = commentRevealScroll({
					currentScroll: scroller.scrollTop,
					gap: 20,
					maxScroll: scroller.scrollHeight - scroller.clientHeight,
					passageBottom: Math.max(...passages.map(passage => passage.bottom)) - shift,
					passageTop: Math.min(...passages.map(passage => passage.top)) - shift,
					sheetTop: commentSheetTop(
						{ top: 0, height: window.innerHeight - keyboard },
						sheet.offsetHeight,
					),
					viewportTop: host.getBoundingClientRect().top,
				});
				if (Math.abs(next - scroller.scrollTop) >= 1) scroller.scrollTop = next;
			});
		};
		reveal();
		let observer = new ResizeObserver(reveal);
		observer.observe(sheet);
		let off = listenToViewportChanges(reveal);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			off();
		};
	}, [host, id, passages, sheet]);
}
