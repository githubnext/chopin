import { type RefObject, useEffect, useRef } from "react";

import "./overlay-scrollbar.css";

/** How long the thumb stays after the last scroll, as an overlay scrollbar lingers. */
const LINGER_MS = 1000;

/**
 * The transcript's scrollbar, drawn over its rows as Slack's message pane draws its own. The
 * native bar is hidden (`.chat-scroll`), so no lane is set aside and a row's shade reaches the
 * pane's edge; this thumb sits over the rows' end, shows while the pane is scrolled or pointed at,
 * and can be dragged. Keyboard scrolling, anchoring and screen readers are the scroller's own and
 * unchanged; the thumb is hidden from assistive technology.
 *
 * It costs the transcript nothing: sizes come from the resize observer's entries, not from the
 * layout, a scroll reads only the offset, and every write is to the thumb's own element.
 */
export function OverlayScrollbar(
	{ scroller, content }: {
		scroller: RefObject<HTMLElement | null>;
		/** The scroller's one child in flow, whose height is what scrolls. */
		content: RefObject<HTMLElement | null>;
	},
) {
	let track = useRef<HTMLDivElement>(null);
	let thumb = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let view = scroller.current;
		let stack = content.current;
		let lane = track.current;
		let bar = thumb.current;
		if (!view || !stack || !lane || !bar) return;
		let floor = Number.parseFloat(getComputedStyle(bar).minHeight) || 0;
		let padding = 0;
		let shown = 0;
		let inner = 0;
		let height = 0;
		let size = 0;
		let travel = 0;
		let range = 0;
		let linger = 0;
		let place = (offset: number) => {
			bar.style.translate = range > 0
				? `0 ${Math.round(Math.min(1, offset / range) * travel * 100) / 100}px`
				: "";
		};
		let observer = new ResizeObserver(entries => {
			for (let entry of entries) {
				let block = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
				if (entry.target === view) {
					shown = block;
					let style = getComputedStyle(view);
					padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
				} else if (entry.target === stack) inner = block;
				else height = block;
			}
			let offset = view.scrollTop;
			range = Math.max(0, Math.round(padding + inner - shown));
			let next = range > 0 ? Math.max(floor, height * shown / (shown + range)) : 0;
			if (next !== size) {
				size = next;
				bar.style.height = `${size}px`;
			}
			travel = height - size;
			if (lane.hasAttribute("data-idle") !== range <= 0) lane.toggleAttribute("data-idle");
			place(offset);
		});
		observer.observe(view, { box: "border-box" });
		observer.observe(stack, { box: "border-box" });
		observer.observe(lane, { box: "border-box" });

		let scrolled = () => {
			place(view.scrollTop);
			if (!lane.hasAttribute("data-scrolling")) lane.toggleAttribute("data-scrolling", true);
			clearTimeout(linger);
			linger = window.setTimeout(() => lane.removeAttribute("data-scrolling"), LINGER_MS);
		};
		view.addEventListener("scroll", scrolled, { passive: true });

		// Dragging the thumb scrolls the transcript by as much as the thumb travels, scaled.
		let from = 0;
		let start = 0;
		let down = (event: PointerEvent) => {
			if (event.button !== 0 || travel <= 0) return;
			event.preventDefault();
			bar.setPointerCapture(event.pointerId);
			from = event.clientY;
			start = view.scrollTop;
			lane.toggleAttribute("data-dragging", true);
		};
		let move = (event: PointerEvent) => {
			if (!bar.hasPointerCapture(event.pointerId)) return;
			view.scrollTop = start + (event.clientY - from) * range / travel;
		};
		let up = (event: PointerEvent) => {
			if (bar.hasPointerCapture(event.pointerId)) bar.releasePointerCapture(event.pointerId);
			lane.removeAttribute("data-dragging");
		};
		bar.addEventListener("pointerdown", down);
		bar.addEventListener("pointermove", move);
		bar.addEventListener("pointerup", up);
		bar.addEventListener("pointercancel", up);
		return () => {
			observer.disconnect();
			clearTimeout(linger);
			view.removeEventListener("scroll", scrolled);
			bar.removeEventListener("pointerdown", down);
			bar.removeEventListener("pointermove", move);
			bar.removeEventListener("pointerup", up);
			bar.removeEventListener("pointercancel", up);
		};
	}, [scroller, content]);

	return (
		<div aria-hidden="true" className="chat-scroll-track" data-idle="" ref={track}>
			<div className="chat-scroll-thumb" ref={thumb} />
		</div>
	);
}
