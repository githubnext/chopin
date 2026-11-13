/**
 * How far an element is scrolled, 0 at its start and 1 at its end, read without laying out the page.
 *
 * `scrollTop` asks the browser to lay the page out first. In a scroll event that is a layout of its
 * own on every step whenever the pointer rests on the scroller: the rows that moved under it have just
 * changed their `:hover`. A scroll timeline's time is the offset the browser took for the frame
 * before it ran the scroll events, so reading it there costs nothing and is current.
 *
 * Undefined where the browser has no scroll timelines; read `scrollTop` there.
 */
export function scrollProgress(view: Element): (() => number) | undefined {
	if (typeof ScrollTimeline === "undefined") return undefined;
	let timeline = new ScrollTimeline({ source: view, axis: "block" });
	return () => {
		let time = timeline.currentTime;
		// A view that cannot scroll, or is not drawn, has no time: it is at its start.
		return time instanceof CSSUnitValue ? Math.min(1, Math.max(0, time.value / 100)) : 0;
	};
}
