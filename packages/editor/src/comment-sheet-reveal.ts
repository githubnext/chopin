import { useLayoutEffect } from "react";

import { commentRevealScroll } from "./comment-reveal";
import { planScroller } from "./scroll";

import type { Rect } from "./comment-geometry";

/** Keep a compact comment beside its passage, then return the reader on close. */
export function useCommentSheetReveal({
	height,
	host,
	id,
	passages,
}: {
	height: number | undefined;
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
		if (!host || !id || !height || !passages || passages.length === 0) return;
		let dialog = document.getElementById(`plan-comment-thread-${id}`);
		let scroller = planScroller(host);
		if (!dialog || !scroller) return;
		let next = commentRevealScroll({
			currentScroll: scroller.scrollTop,
			gap: 20,
			maxScroll: scroller.scrollHeight - scroller.clientHeight,
			passageBottom: Math.max(...passages.map(passage => passage.bottom)),
			passageTop: Math.min(...passages.map(passage => passage.top)),
			sheetTop: dialog.getBoundingClientRect().top,
			viewportTop: host.getBoundingClientRect().top,
		});
		if (Math.abs(next - scroller.scrollTop) >= 1) scroller.scrollTop = next;
	}, [height, host, id, passages]);
}
