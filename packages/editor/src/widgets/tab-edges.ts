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
