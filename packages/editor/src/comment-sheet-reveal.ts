import { useLayoutEffect } from "react";

import { currentViewport } from "@chopin/viewport";

import { commentRevealScroll } from "./comment-reveal";
import { commentSheetTop } from "./comment-sheet";
import { planScroller } from "./scroll";

import type { Rect } from "./comment-geometry";

/** Keep a compact comment beside its passage, then return the reader on close. */
export function useCommentSheetReveal({
	host,
	id,
	passages,
}: {
	host: HTMLElement | undefined;
	id: string | undefined;
	passages: Rect[] | undefined;
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
		if (!host || !id || !passages || passages.length === 0) return;
		let scroller = planScroller(host);
		if (!scroller) return;
		let frame = requestAnimationFrame(() => {
			if (!scroller.isConnected) return;
			let viewport = currentViewport();
			let next = commentRevealScroll({
				currentScroll: scroller.scrollTop,
				gap: 20,
				maxScroll: scroller.scrollHeight - scroller.clientHeight,
				passageBottom: Math.max(...passages.map(passage => passage.bottom)),
				passageTop: Math.min(...passages.map(passage => passage.top)),
				sheetTop: viewport.top + commentSheetTop(viewport.height),
				viewportTop: host.getBoundingClientRect().top,
			});
			if (Math.abs(next - scroller.scrollTop) >= 1) scroller.scrollTop = next;
		});
		return () => cancelAnimationFrame(frame);
	}, [host, id, passages]);
}
