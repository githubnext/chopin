export type Rect = {
	top: number;
	right: number;
	bottom: number;
	left: number;
	width: number;
	height: number;
};

export type Point = { top: number; left: number };
/** An offscreen marker follows its block outside the document and is not shown. */
export type MarkerPoint = Point & { offscreen?: true };

/** A decision marker sits before the first line of its decided paragraph. */
export function marginPoint(target: Rect, host: Rect, size = 24, gap = 8): Point {
	return {
		top: clamp(target.top - host.top, 0, host.height - size),
		left: clamp(target.left - host.left - size - gap, 0, host.width - size),
	};
}

/** A decision preview and its pinned popover share a position beneath the prose. */
export function decisionPanelPoint(
	target: Rect,
	host: Rect,
	width: number,
	height: number,
	gap = 6,
): Point {
	let below = target.bottom - host.top + gap;
	let above = target.top - host.top - height - gap;
	return {
		top: below + height <= host.height
			? below
			: above >= 0
			? above
			: clamp(below, 0, host.height - height),
		left: clamp(target.left - host.left, 0, host.width - width),
	};
}

export function markerRect(point: Point, host: Rect, size: number): Rect {
	return {
		top: host.top + point.top,
		right: host.left + point.left + size,
		bottom: host.top + point.top + size,
		left: host.left + point.left,
		width: size,
		height: size,
	};
}

/**
 * One commented block: its box, its first line, and the visible chip's width.
 * `held` keeps a focused or open marker on screen at the nearest edge.
 */
export type BlockMarker = {
	block: Rect;
	line: { top: number; height: number };
	width: number;
	held?: boolean;
	/** The narrowest slim chip that still shows its content, such as a two-digit count. */
	minimum?: number;
};
/** `slim` marks a chip narrowed to fit the content padding beside its block. */
export type BlockMarkerPoint = MarkerPoint & { width: number; slim?: true };

/**
 * Place one marker per block in the right gutter, centred on the block's first line.
 *
 * Never over prose: when the gutter cannot hold the chip, it narrows to `slim`
 * and sits inside the padding beside the block. Markers are given in document
 * order; one that would overlap the marker above it moves down beneath it.
 */
export function blockMarkerPoints(
	markers: BlockMarker[],
	host: Rect,
	{ size = 24, gap = 8, slim = 14 }: { size?: number; gap?: number; slim?: number } = {},
): BlockMarkerPoint[] {
	let previous: Rect | undefined;
	return markers.map(({ block, held, line, minimum = 0, width }) => {
		let gutter = host.right - block.right;
		let wide = gutter >= width + gap * 1.5;
		let chip = wide
			? width
			: Math.min(width, Math.max(minimum, Math.min(slim, gutter - 2)));
		let left = wide
			? block.right - host.left + gap
			: block.right - host.left + Math.max(0, (gutter - chip) / 2);
		let top = line.top - host.top + (line.height - size) / 2;
		if (previous && top < previous.bottom - host.top + 4 && top + size > previous.top - host.top) {
			top = previous.bottom - host.top + 4;
		}
		let point: BlockMarkerPoint = {
			top,
			left: clamp(left, 0, host.width - chip),
			width: chip,
			...(wide ? {} : { slim: true as const }),
		};
		if (top + size <= 0 || top >= host.height) {
			if (!held) return { ...point, offscreen: true };
			point.top = clamp(top, 0, host.height - size);
		}
		previous = {
			top: host.top + point.top,
			right: host.left + point.left + chip,
			bottom: host.top + point.top + size,
			left: host.left + point.left,
			width: chip,
			height: size,
		};
		return point;
	});
}

export function popoverPoint(
	button: Rect,
	host: Rect,
	width: number,
	height: number,
	gap = 8,
): Point {
	let right = button.right + gap + width <= host.right;
	return {
		top: clamp(button.top - host.top, 0, host.height - height),
		left: clamp(
			right ? button.right - host.left + gap : button.left - host.left - width - gap,
			0,
			host.width - width,
		),
	};
}

/** Keep an engaged comment in one predictable document-edge surface. */
export function edgePanelPoint(
	anchor: Rect,
	host: Rect,
	width: number,
	height: number,
	inset = 12,
): Point {
	return {
		top: clamp(anchor.top - host.top, inset, host.height - height - inset),
		left: Math.max(inset, host.width - width - inset),
	};
}

function clamp(value: number, lower: number, upper: number): number {
	return Math.min(Math.max(value, lower), Math.max(lower, upper));
}
