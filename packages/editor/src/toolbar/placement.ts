export type ViewportBox = { left: number; top: number; width: number; height: number };

export type DOMRectLike = {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
};

export type SurfacePlacement = { left: number; top: number; maxHeight: number };

export function intersectViewport(viewport: ViewportBox, host: DOMRectLike): ViewportBox {
	let right = Math.min(viewport.left + viewport.width, host.right);
	let bottom = Math.min(viewport.top + viewport.height, host.bottom);
	let left = Math.max(viewport.left, host.left);
	let top = Math.max(viewport.top, host.top);
	return {
		left,
		top,
		width: Math.max(0, right - left),
		height: Math.max(0, bottom - top),
	};
}

/** Place fixed editor chrome within the pixels the browser currently exposes. */
export function placeSurface(
	anchor: DOMRectLike,
	surface: { width: number; height: number },
	viewport: ViewportBox,
	gap = 8,
	prefer: "auto" | "above" = "auto",
): SurfacePlacement {
	let leftEdge = viewport.left + gap;
	let rightEdge = viewport.left + viewport.width - gap;
	let topEdge = viewport.top + gap;
	let bottomEdge = viewport.top + viewport.height - gap;
	let left = clamp(anchor.left, leftEdge, rightEdge - surface.width);
	let above = Math.max(0, anchor.top - gap - topEdge);
	let below = Math.max(0, bottomEdge - anchor.bottom - gap);
	// `above` keeps a surface off the line under a selection and flips only
	// when the whole surface no longer fits over it and below has more room.
	let useAbove = prefer === "above" ? above >= surface.height || above >= below : above > below;

	if (useAbove) {
		let top = Math.max(topEdge, anchor.top - gap - surface.height);
		return {
			left,
			top,
			maxHeight: Math.max(0, Math.min(surface.height, anchor.top - gap - top, bottomEdge - top)),
		};
	}

	let top = Math.max(topEdge, Math.min(anchor.bottom + gap, bottomEdge));
	return {
		left,
		top,
		maxHeight: Math.max(0, Math.min(surface.height, bottomEdge - top)),
	};
}

function clamp(value: number, lower: number, upper: number): number {
	return Math.min(Math.max(value, lower), Math.max(lower, upper));
}

/**
 * The part of a selection the viewport shows, or nothing once most of it has
 * scrolled away. A selection taller than the viewport keeps its visible slice.
 */
export function visibleAnchor(anchor: DOMRectLike, viewport: ViewportBox): DOMRectLike | undefined {
	let top = Math.max(anchor.top, viewport.top);
	let bottom = Math.min(anchor.bottom, viewport.top + viewport.height);
	let shown = bottom - top;
	if (shown <= 0 || shown < Math.min(anchor.height / 2, 20)) return undefined;
	return { ...anchor, top, bottom, height: shown };
}

export type DraftPlacement = {
	left: number;
	top: number;
	side: "below" | "above" | "pinned" | "away";
	/** The scroll distance that would show the anchor's last line and the whole draft below it. */
	reveal: number;
};

/**
 * Place an inline draft under its anchor block, inside the visible pixels.
 *
 * The draft follows its anchor while the anchor is on screen. When the space
 * below runs out it flips above, then pins to the nearest edge. Once the anchor
 * has scrolled away entirely the draft goes with it rather than floating free.
 */
export function placeDraft(
	anchor: DOMRectLike,
	surface: { width: number; height: number },
	bounds: ViewportBox,
	gap = 8,
	line = 24,
): DraftPlacement {
	let topEdge = bounds.top + gap;
	let bottomEdge = bounds.top + bounds.height - gap;
	let left = clamp(
		anchor.left,
		bounds.left + gap,
		bounds.left + bounds.width - gap - surface.width,
	);
	let lineTop = anchor.bottom - Math.min(line, anchor.height);
	let below = anchor.bottom;
	let reveal = 0;
	if (surface.height + anchor.bottom - lineTop > bottomEdge - topEdge) reveal = lineTop - topEdge;
	else if (below + surface.height > bottomEdge) reveal = below + surface.height - bottomEdge;
	else if (lineTop < topEdge) reveal = lineTop - topEdge;

	// Scroll offsets land on whole pixels, so a revealed draft may sit a fraction past the edge.
	if (below >= topEdge - 1 && below + surface.height <= bottomEdge + 1) {
		return { left, top: below, side: "below", reveal };
	}
	if (anchor.bottom < topEdge || anchor.top > bottomEdge) {
		return { left, top: below, side: "away", reveal };
	}
	let above = anchor.top - surface.height;
	if (below + surface.height > bottomEdge && above >= topEdge) {
		return { left, top: above, side: "above", reveal };
	}
	return {
		left,
		top: clamp(below, topEdge, bottomEdge - surface.height),
		side: "pinned",
		reveal,
	};
}

/** How far a placed draft overflows the visible bounds at its top and bottom edges. */
export function draftOverflow(
	top: number,
	height: number,
	bounds: ViewportBox,
): { top: number; bottom: number } {
	return {
		top: Math.max(0, bounds.top - top),
		bottom: Math.max(0, top + height - (bounds.top + bounds.height)),
	};
}

/**
 * Where to scroll to reveal a draft: back to where the reader was when it
 * opened if the draft fits there, otherwise the smallest scroll that shows it.
 */
export function revealTarget(
	scrollTop: number,
	openedAt: number | undefined,
	placeAt: (shift: number) => DraftPlacement,
	reveal: number,
): number {
	if (openedAt !== undefined && openedAt !== scrollTop) {
		let shift = scrollTop - openedAt;
		let back = placeAt(shift);
		if (back.side === "below" && back.reveal === 0) return openedAt;
	}
	return scrollTop + reveal;
}
