export type CommentRevealLayout = {
	currentScroll: number;
	gap: number;
	maxScroll: number;
	passageBottom: number;
	passageTop: number;
	sheetTop: number;
	viewportTop: number;
};

export function commentRevealScroll(layout: CommentRevealLayout): number {
	let revealTop = layout.viewportTop + layout.gap;
	let revealBottom = layout.sheetTop - layout.gap;
	let passageHeight = layout.passageBottom - layout.passageTop;
	let availableHeight = revealBottom - revealTop;
	let delta = passageHeight <= availableHeight
		? layout.passageBottom - revealBottom
		: layout.passageTop - revealTop;
	return Math.min(layout.maxScroll, Math.max(0, layout.currentScroll + delta));
}
