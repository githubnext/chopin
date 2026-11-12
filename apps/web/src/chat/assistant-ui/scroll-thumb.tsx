import { useLayoutEffect, useRef } from "react";

/** How far a vertical lane stops short of each end of its scroller, in pixels. */
const END_MARGIN = 4;

/**
 * A quiet scrollbar drawn beside one of the model selector's scrollers, so a person sees there are
 * more models or levels than the popover shows: the copied element hides its native bar, and a
 * system's overlay bar shows only while scrolling. It is drawn whenever the scroller overflows,
 * without a pointer over it, sized and placed by how much of the content is in view, and gone when
 * everything fits. A mouse can drag it; wheel, touch and keys scroll the scroller as before, and
 * the thumb is hidden from assistive technology, which reads the scroller itself.
 *
 * The track is placed in its parent, which is positioned, along the edge of the scroller `find`
 * returns from it. The scroller can come and go (a model without levels has no lane), so it is
 * looked for again whenever the parent's contents change. Places are read from offsets, which the
 * popover's entrance scale leaves alone.
 */
export function ScrollThumb(
	{ axis, find }: { axis: "x" | "y"; find: (host: HTMLElement) => HTMLElement | null },
) {
	let track = useRef<HTMLDivElement>(null);
	let thumb = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		let lane = track.current;
		let bar = thumb.current;
		let host = lane?.parentElement;
		if (!lane || !bar || !host) return;
		let across = axis === "x";
		let view: HTMLElement | null = null;
		let range = 0;
		let travel = 0;
		let frame = 0;

		let draw = () => {
			frame = 0;
			let next = find(host);
			if (next !== view) bind(next);
			let shown = view ? (across ? view.clientWidth : view.clientHeight) : 0;
			let whole = view ? (across ? view.scrollWidth : view.scrollHeight) : 0;
			range = Math.max(0, whole - shown);
			lane.toggleAttribute("data-idle", !view || range < 1);
			if (!view || range < 1) return;
			let left = 0;
			let top = 0;
			for (let node: HTMLElement | null = view; node && node !== host;) {
				left += node.offsetLeft;
				top += node.offsetTop;
				node = node.offsetParent as HTMLElement | null;
			}
			// A lane down the list stops short of its ends, as Chat's does, clear of the corners.
			let margin = across ? 0 : END_MARGIN;
			let length = (across ? view.offsetWidth : view.offsetHeight) - 2 * margin;
			if (across) {
				lane.style.left = `${left}px`;
				lane.style.width = `${length}px`;
			} else {
				lane.style.top = `${top + margin}px`;
				lane.style.height = `${length}px`;
			}
			let floor = parseFloat(getComputedStyle(bar)[across ? "minWidth" : "minHeight"]) || 0;
			let size = Math.max(floor, length * shown / whole);
			travel = length - size;
			let offset = across ? view.scrollLeft : view.scrollTop;
			let at = Math.round(Math.min(1, offset / range) * travel * 100) / 100;
			if (across) {
				bar.style.width = `${size}px`;
				bar.style.translate = `${at}px 0`;
			} else {
				bar.style.height = `${size}px`;
				bar.style.translate = `0 ${at}px`;
			}
		};
		let schedule = () => {
			if (!frame) frame = requestAnimationFrame(draw);
		};

		let sizes = new ResizeObserver(schedule);
		let changes = new MutationObserver(schedule);
		changes.observe(host, { childList: true, subtree: true });
		sizes.observe(host);
		let bind = (next: HTMLElement | null) => {
			view?.removeEventListener("scroll", schedule);
			sizes.disconnect();
			sizes.observe(host);
			view = next;
			if (!view) return;
			view.addEventListener("scroll", schedule, { passive: true });
			sizes.observe(view);
			for (let child of view.children) sizes.observe(child);
		};

		// Dragging the thumb scrolls the scroller by as much as the thumb travels, scaled.
		let from = 0;
		let start = 0;
		let down = (event: PointerEvent) => {
			if (event.button !== 0 || travel <= 0 || !view) return;
			event.preventDefault();
			bar.setPointerCapture(event.pointerId);
			from = across ? event.clientX : event.clientY;
			start = across ? view.scrollLeft : view.scrollTop;
			lane.toggleAttribute("data-dragging", true);
		};
		let move = (event: PointerEvent) => {
			if (!view || !bar.hasPointerCapture(event.pointerId)) return;
			let moved = start + ((across ? event.clientX : event.clientY) - from) * range / travel;
			if (across) view.scrollLeft = moved;
			else view.scrollTop = moved;
		};
		let up = (event: PointerEvent) => {
			if (bar.hasPointerCapture(event.pointerId)) bar.releasePointerCapture(event.pointerId);
			lane.removeAttribute("data-dragging");
		};
		bar.addEventListener("pointerdown", down);
		bar.addEventListener("pointermove", move);
		bar.addEventListener("pointerup", up);
		bar.addEventListener("pointercancel", up);
		draw();
		return () => {
			cancelAnimationFrame(frame);
			sizes.disconnect();
			changes.disconnect();
			view?.removeEventListener("scroll", schedule);
			bar.removeEventListener("pointerdown", down);
			bar.removeEventListener("pointermove", move);
			bar.removeEventListener("pointerup", up);
			bar.removeEventListener("pointercancel", up);
		};
	}, [axis, find]);

	return (
		<div
			aria-hidden="true"
			className="model-scroll-track"
			data-axis={axis}
			data-idle=""
			ref={track}
		>
			<div className="model-scroll-thumb" ref={thumb} />
		</div>
	);
}
