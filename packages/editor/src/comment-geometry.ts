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

/** A line box: where a line of prose starts and how tall it is. */
export type Line = { top: number; height: number };

/**
 * The first line a passage starts on, from its range's client rects.
 *
 * The rect that ends earliest is a glyph run on that line: a fully selected
 * element contributes its whole box, which ends below its first line, and the
 * zero-width tail of a line the range starts at the end of is not a line. The
 * run is narrower than its line box, so `lineHeight`, the start element's own
 * computed one, is centred on it when it is known.
 */
export function passageLine(rects: Iterable<Rect>, lineHeight?: number): Line | undefined {
	let first: Rect | undefined;
	for (let item of rects) {
		if (item.width <= 0 || item.height <= 0) continue;
		if (
			!first || item.bottom < first.bottom || (item.bottom === first.bottom && item.top < first.top)
		) {
			first = item;
		}
	}
	if (!first) return undefined;
	if (lineHeight === undefined || !Number.isFinite(lineHeight) || lineHeight <= 0) {
		return { top: first.top, height: first.height };
	}
	return { top: first.top + (first.height - lineHeight) / 2, height: lineHeight };
}

/** Two line boxes are one visual line when they overlap by half the shorter one. */
export function sameLine(a: Line, b: Line): boolean {
	let overlap = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
	return overlap >= Math.min(a.height, b.height) / 2;
}

export type LineEntry = { id: string; block: string; line: Line };
export type LineGroup<T extends LineEntry> = { key: string; line: Line; entries: T[] };

/**
 * Threads whose passages start on the same visual line of the same block share
 * one marker; any other thread gets its own, beside its own line.
 *
 * A group is keyed by its earliest thread id (ids are ULIDs, so creation order)
 * rather than its block or line index: a newer thread joining the line, a
 * reflow, or another group appearing above leaves the key alone, so focus,
 * hover and a pinned list survive re-measuring. Entries keep their given
 * order; groups come out top to bottom.
 */
export function lineGroups<T extends LineEntry>(entries: T[]): LineGroup<T>[] {
	let groups: LineGroup<T>[] = [];
	let blocks: string[] = [];
	for (let entry of entries) {
		let index = groups.findIndex((group, at) =>
			blocks[at] === entry.block && sameLine(group.line, entry.line)
		);
		let group = groups[index];
		if (!group) {
			groups.push({ key: entry.id, line: entry.line, entries: [entry] });
			blocks.push(entry.block);
			continue;
		}
		group.entries.push(entry);
		if (entry.id < group.key) group.key = entry.id;
		if (entry.line.top < group.line.top) group.line = entry.line;
	}
	return groups.sort((a, b) => a.line.top - b.line.top);
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

/** Where the card sits relative to its passage, so its entrance can come from there. */
export type CardSide = "right" | "below" | "above";
export type CardPoint = Point & { width: number; side: CardSide; maxHeight?: number };

/**
 * Place an open comment card where it never covers its own passage.
 *
 * When the gutter right of the prose column holds the card beyond the marker
 * lane, it sits there beside the passage's first line. Otherwise it sits
 * directly below the passage, or above it when only that side has room, aligned
 * to the column's right edge so it opens beneath the marker that raised it. A
 * draft has no marker yet: `align: "passage"` keeps it at the selection's left
 * edge instead, inside the column. When neither side
 * holds the whole card, the roomier side caps its height so it scrolls instead.
 * A passage scrolled out of view lets the card clamp back inside the document.
 */
export function commentCardPoint(
	passage: Rect,
	column: Rect,
	host: Rect,
	width: number,
	height: number,
	{ align = "column", gap = 8, inset = 12, lane = 56, minWidth = 264 }: {
		align?: "column" | "passage";
		gap?: number;
		inset?: number;
		lane?: number;
		minWidth?: number;
	} = {},
): CardPoint {
	let gutter = host.right - inset - (column.right + lane);
	if (gutter >= minWidth) {
		let fitted = Math.min(width, gutter);
		let room = host.height - inset * 2;
		return {
			top: clamp(passage.top - host.top, inset, host.height - height - inset),
			left: column.right + lane - host.left,
			width: fitted,
			side: "right",
			...(height > room ? { maxHeight: room } : {}),
		};
	}

	let fitted = Math.min(width, column.width);
	let left = align === "passage"
		? clamp(passage.left - host.left, column.left - host.left, column.right - host.left - fitted)
		: clamp(column.right - host.left - fitted, 0, host.width - fitted);
	let below = host.bottom - inset - (passage.bottom + gap);
	let above = passage.top - gap - (host.top + inset);
	let point: CardPoint = {
		top: passage.bottom + gap - host.top,
		left,
		width: fitted,
		side: "below",
	};
	if (height > below) {
		if (height <= above) {
			point.top = passage.top - gap - height - host.top;
			point.side = "above";
		} else if (above > below) {
			point.top = inset;
			point.maxHeight = above;
			point.side = "above";
		} else point.maxHeight = below;
	}
	let shown = Math.min(height, point.maxHeight ?? height);
	point.top = clamp(point.top, inset, host.height - shown - inset);
	return point;
}

function clamp(value: number, lower: number, upper: number): number {
	return Math.min(Math.max(value, lower), Math.max(lower, upper));
}
