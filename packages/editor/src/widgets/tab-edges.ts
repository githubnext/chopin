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
	// An item too wide to clear both fades gets only the room that exists, so the
	// two sides can never pull against each other.
	let room = Math.max(0, Math.min(inset, (view.right - view.left - (item.right - item.left)) / 2));
	if (item.left < view.left + room) return item.left - view.left - room;
	if (item.right > view.right - room) return item.right - view.right + room;
	return 0;
}
