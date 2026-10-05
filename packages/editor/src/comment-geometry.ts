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

export type CardPoint = Point & { width: number; maxHeight?: number };

/**
 * Place an open comment card where it never covers its own passage.
 *
 * When the gutter right of the prose column holds the card beyond the marker
 * lane, it sits there beside the passage's first line. Otherwise it sits
 * directly below the passage, or above it when only that side has room, aligned
 * to the passage's left edge and kept inside the column. When neither side
 * holds the whole card, the roomier side caps its height so it scrolls instead.
 * A passage scrolled out of view lets the card clamp back inside the document.
 */
export function commentCardPoint(
	passage: Rect,
	column: Rect,
	host: Rect,
	width: number,
	height: number,
	{ gap = 8, inset = 12, lane = 40, minWidth = 264 }: {
		gap?: number;
		inset?: number;
		lane?: number;
		minWidth?: number;
	} = {},
): CardPoint {
	let gutter = host.right - inset - (column.right + lane);
	if (gutter >= minWidth) {
		let fitted = Math.min(width, gutter);
		return {
			top: clamp(passage.top - host.top, inset, host.height - height - inset),
			left: column.right + lane - host.left,
			width: fitted,
		};
	}

	let fitted = Math.min(width, column.width);
	let left = clamp(
		passage.left - host.left,
		column.left - host.left,
		column.right - host.left - fitted,
	);
	let below = host.bottom - inset - (passage.bottom + gap);
	let above = passage.top - gap - (host.top + inset);
	let point: CardPoint = { top: passage.bottom + gap - host.top, left, width: fitted };
	if (height > below) {
		if (height <= above) point.top = passage.top - gap - height - host.top;
		else if (above > below) {
			point.top = inset;
			point.maxHeight = above;
		} else point.maxHeight = below;
	}
	let shown = Math.min(height, point.maxHeight ?? height);
	point.top = clamp(point.top, inset, host.height - shown - inset);
	return point;
}

function clamp(value: number, lower: number, upper: number): number {
	return Math.min(Math.max(value, lower), Math.max(lower, upper));
}
