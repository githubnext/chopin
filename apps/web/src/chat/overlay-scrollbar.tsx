import { type RefObject, useLayoutEffect, useRef } from "react";

import "./overlay-scrollbar.css";
import { scrollProgress } from "./scroll-progress";

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
 * layout, a scroll reads only how far it has gone, from a scroll timeline where there is one, and
 * every write is to the thumb's own element.
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

	// Set up as the transcript mounts, before it first scrolls to its newest line, so every scroll is
	// heard and the thumb never has to ask the scroller where it is.
	useLayoutEffect(() => {
		let view = scroller.current;
		let lane = track.current;
		let bar = thumb.current;
		let stack = content.current;
		if (!view || !stack || !lane || !bar) return;
		let shown = 0;
		let padding = 0;
		let inner = 0;
		let height = 0;
		// The thumb is drawn never shorter than its floor. It is read once, from style alone, so the
		// thumb's travel always counts the box it is drawn in: counted from the size it is asked for, a
		// thumb held at its floor (a long transcript, or one the runs card has shortened) was moved past
		// the lane's end, where the lane's paint containment cut it off.
		let floor = Number.parseFloat(getComputedStyle(bar).minHeight) || 0;
		let size = 0;
		let travel = 0;
		let range = 0;
		let offset = 0;
		let linger = 0;
		let idle = true;
		let scrolling = false;
		let pointed = false;
		let frame = 0;
		// Every write is the thumb's and waits for the next frame, where the page is styled anyway.
		let draw = () => {
			frame = 0;
			if (bar.style.height !== `${size}px`) bar.style.height = `${size}px`;
			bar.style.translate = range > 0
				? `0 ${Math.round(Math.min(1, offset / range) * travel * 100) / 100}px`
				: "";
			if (lane.hasAttribute("data-idle") !== idle) lane.toggleAttribute("data-idle", idle);
			if (lane.hasAttribute("data-scrolling") !== scrolling) {
				lane.toggleAttribute("data-scrolling", scrolling);
			}
			if (lane.hasAttribute("data-pointed") !== pointed) {
				lane.toggleAttribute("data-pointed", pointed);
			}
		};
		let schedule = () => {
			if (!frame) frame = requestAnimationFrame(draw);
		};
		let measure = () => {
			range = Math.max(0, Math.round(padding + inner - shown));
			size = range > 0 ? height * shown / (shown + range) : 0;
			travel = Math.max(0, height - Math.max(size, floor));
			idle = range <= 0;
			schedule();
		};
		// Every size comes from the resize observer's entries and the offset from the scroll event, so
		// nothing here asks the page to lay out.
		let observer = new ResizeObserver(entries => {
			for (let entry of entries) {
				let block = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
				if (entry.target === view) {
					shown = block;
					padding = block - (entry.contentBoxSize[0]?.blockSize ?? entry.contentRect.height);
				} else if (entry.target === stack) inner = block;
				else height = block;
			}
			measure();
		});
		observer.observe(view, { box: "border-box" });
		observer.observe(stack, { box: "border-box" });
		observer.observe(lane, { box: "border-box" });

		let progress = scrollProgress(view);
		let scrolled = () => {
			offset = progress ? progress() * range : view.scrollTop;
			scrolling = true;
			schedule();
			clearTimeout(linger);
			linger = window.setTimeout(() => {
				scrolling = false;
				schedule();
			}, LINGER_MS);
		};
		view.addEventListener("scroll", scrolled, { passive: true });
		// The pane says the pointer is on it by a mark on the thumb's lane. A `:hover` of the pane in the
		// stylesheet restyled the whole transcript each time the pointer came or went.
		let host = lane.parentElement!;
		let enter = () => {
			pointed = true;
			schedule();
		};
		let leave = () => {
			pointed = false;
			schedule();
		};
		host.addEventListener("pointerenter", enter);
		host.addEventListener("pointerleave", leave);

		// Dragging the thumb scrolls the transcript by as much as the thumb travels, scaled.
		let from = 0;
		let start = 0;
		let down = (event: PointerEvent) => {
			if (event.button !== 0 || travel <= 0) return;
			event.preventDefault();
			bar.setPointerCapture(event.pointerId);
			from = event.clientY;
			start = offset;
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
			cancelAnimationFrame(frame);
			view.removeEventListener("scroll", scrolled);
			host.removeEventListener("pointerenter", enter);
			host.removeEventListener("pointerleave", leave);
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
