/** Which sides of a horizontally scrolling strip still hide content. */
export function scrollEdges(
	scrollLeft: number,
	clientWidth: number,
	scrollWidth: number,
): { start: boolean; end: boolean } {
	return {
		start: scrollLeft > 1,
		end: scrollLeft + clientWidth < scrollWidth - 1,
	};
}

/** Soft fade on whichever sides have more content; `undefined` when nothing overflows. */
export function edgeMask(edges: { start: boolean; end: boolean }): string | undefined {
	if (!edges.start && !edges.end) return undefined;
	let fade = "calc(var(--spacing) * 8)";
	let start = edges.start ? "transparent" : "black";
	let end = edges.end ? "transparent" : "black";
	return `linear-gradient(to right, ${start}, black ${fade}, black calc(100% - ${fade}), ${end})`;
}

/** Scroll distance that brings an item fully inside the strip, clear of the fades. */
export function revealDelta(
	view: { left: number; right: number },
	item: { left: number; right: number },
	inset: number,
): number {
	if (item.left < view.left + inset) return item.left - view.left - inset;
	// An item wider than the clear area stays start-aligned instead of flip-flopping.
	if (item.right - item.left > view.right - view.left - 2 * inset) {
		return item.left - view.left - inset;
	}
	if (item.right > view.right - inset) return item.right - view.right + inset;
	return 0;
}
