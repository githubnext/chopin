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
): SurfacePlacement {
	let leftEdge = viewport.left + gap;
	let rightEdge = viewport.left + viewport.width - gap;
	let topEdge = viewport.top + gap;
	let bottomEdge = viewport.top + viewport.height - gap;
	let left = clamp(anchor.left, leftEdge, rightEdge - surface.width);
	let above = Math.max(0, anchor.top - gap - topEdge);
	let below = Math.max(0, bottomEdge - anchor.bottom - gap);
	let useAbove = above > below;

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
