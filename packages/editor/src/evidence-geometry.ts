/** Viewport placement for evidence portalled outside the clipped document column. */

import type { Rect } from "./comment-geometry";

export const HOVER_OPEN_MS = 400;
export const HOVER_CLOSE_MS = 150;

/** A dismissed overlay can expose the stationary pointer to its card underneath. */
export function pointerOverCard(
	card: Rect,
	pointer: { x: number; y: number } | undefined,
): boolean {
	return !!pointer
		&& pointer.x >= card.left
		&& pointer.x < card.right
		&& pointer.y >= card.top
		&& pointer.y < card.bottom;
}

function clamp(value: number, lower: number, upper: number): number {
	return Math.min(Math.max(value, lower), Math.max(lower, upper));
}

/** Below this width evidence opens as a bottom sheet rather than beside its card. */
export const EVIDENCE_SHEET_WIDTH = 640;

export type EvidenceSide = "right" | "left" | "below" | "above" | "sheet";

export function evidencePoint(
	card: Rect,
	viewport: { width: number; height: number },
	width: number,
	height: number,
	gap = 8,
	inset = 12,
): { top: number; left: number; side: EvidenceSide } {
	if (viewport.width < EVIDENCE_SHEET_WIDTH) return { top: 0, left: 0, side: "sheet" };
	let top = clamp(card.top, inset, viewport.height - height - inset);
	if (card.right + gap + width <= viewport.width - inset) {
		return { top, left: card.right + gap, side: "right" };
	}
	if (card.left - gap - width >= inset) {
		return { top, left: card.left - gap - width, side: "left" };
	}
	let left = clamp(card.left, inset, viewport.width - width - inset);
	if (card.bottom + gap + height <= viewport.height - inset) {
		return { top: card.bottom + gap, left, side: "below" };
	}
	if (card.top - gap - height >= inset) {
		return { top: card.top - gap - height, left, side: "above" };
	}
	return {
		top,
		left: clamp(card.right + gap, inset, viewport.width - width - inset),
		side: "right",
	};
}
