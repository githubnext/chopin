/**
 * Where a drag lands.
 *
 * Two coordinate systems meet here and they do not agree, which is the whole
 * reason this is its own module. A drop is expressed as a *seam* — the line
 * between two tracks, so `n` tracks have `n + 1` of them — because that is what
 * a person aims at and what the insertion line is drawn on. `$moveTableRow` and
 * `$moveTableColumn` instead take a destination *index*, evaluated after the
 * moved track has already been lifted out, so every seam past the one it came
 * from means an index one lower.
 *
 * Off by one here is invisible: nothing throws, the table stays well-formed,
 * and the column simply arrives one place from where it was dropped. Hence a
 * module of plain numbers with no DOM in it.
 */

import { HEADER } from "./shape";

/**
 * Where a track sits along the axis being dragged, in viewport pixels.
 *
 * Measured rather than derived: cells size themselves from their contents, so
 * there is no stride to multiply by.
 */
export type Track = { start: number; end: number };

/**
 * Which way a rail runs.
 *
 * The two rails are one piece of geometry seen twice, with the axes swapped:
 * a column grip is as wide as its column and as tall as the rail, a row grip
 * the other way about. Writing it once and turning it means the two cannot
 * drift apart, which they would, because only one of them is ever the one
 * being looked at while it is worked on.
 */
export type Axis = "column" | "row";

/** The `n + 1` lines a track can be dropped onto. */
export function seams(list: Track[]): number[] {
	if (list.length === 0) return [];
	return [list[0]!.start, ...list.map(track => track.end)];
}

/**
 * The seam a pointer is nearest.
 *
 * Nearest rather than "inside track `n`, so seam `n` or `n + 1`": a pointer
 * beyond either end of the table still has an answer this way, and a drag that
 * overshoots the last column should land after it rather than nowhere.
 */
export function seamAt(list: Track[], position: number): number {
	let lines = seams(list);
	if (lines.length === 0) return 0;

	let best = 0;
	let closest = Infinity;
	for (let index = 0; index < lines.length; index++) {
		let distance = Math.abs(lines[index]! - position);
		// Strictly closer, so a pointer exactly between two seams takes the
		// earlier one rather than depending on which way the loop runs.
		if (distance < closest) {
			closest = distance;
			best = index;
		}
	}
	return best;
}

/**
 * The destination index a seam means, for a track lifted from `from`.
 *
 * Returns undefined when the drop would not move anything — the seam on either
 * side of where the track already is puts it back where it started. Saying so
 * is what lets the caller leave the document alone rather than commit a
 * no-op edit that still costs everyone in the room a sync.
 */
export function destination(from: number, seam: number, count: number): number | undefined {
	if (seam < 0 || seam > count) return undefined;
	// Both seams bounding the track's current position are where it already is.
	if (seam === from || seam === from + 1) return undefined;
	return seam > from ? seam - 1 : seam;
}

/**
 * The seam a drop lands on, once the header is accounted for.
 *
 * A row cannot go above the header, so the seam at the very top of the table is
 * not a target and a drag that reaches for it is clamped to the one below.
 * Clamped rather than refused: a pointer that has run off the top of a short
 * table is still asking for "as high as it goes", and dropping nothing because
 * it went two pixels too far reads as the drag having failed.
 *
 * The clamp is applied here rather than inside `destination` so the insertion
 * line can be drawn on the seam the drop will actually use. Deciding it twice
 * is how the line ends up promising one thing and the drop doing another.
 */
export function dropSeam(axis: Axis, seam: number): number {
	return axis === "row" ? Math.max(seam, HEADER + 1) : seam;
}

/** {@link destination}, for a row, through {@link dropSeam}. */
export function rowDestination(from: number, seam: number, count: number): number | undefined {
	return destination(from, dropSeam("row", seam), count);
}

/** A rectangle relative to the rail it is drawn in. */
export type Box = { left: number; top: number; width: number; height: number };

/**
 * A grip covering one track.
 *
 * `origin` is where the rail starts along the axis, in the same viewport
 * coordinates the tracks were measured in — subtracting it is what turns a
 * measurement of the page into a position inside the rail. `lane` is the
 * offset across the rail, which is what keeps the grips and the buttons in
 * separate lanes: a button sharing a lane with the grip it belongs to sits
 * exactly where a drag would naturally be started from, and swallows it.
 */
export function gripBox(
	axis: Axis,
	track: Track,
	origin: number,
	thickness: number,
	lane = 0,
): Box {
	let extent = Math.max(track.end - track.start, 0);
	let offset = track.start - origin;
	return axis === "column"
		? { left: offset, top: lane, width: extent, height: thickness }
		: { left: lane, top: offset, width: thickness, height: extent };
}

/**
 * A target centred on a seam.
 *
 * Centred rather than starting at it, because a seam is a line with no width
 * and the thing a person aims at straddles it. `size` is the whole extent, so
 * half of it falls on each side of the two tracks the seam divides.
 */
export function seamBox(
	axis: Axis,
	position: number,
	origin: number,
	thickness: number,
	size: number,
	lane = 0,
): Box {
	let offset = position - origin - size / 2;
	return axis === "column"
		? { left: offset, top: lane, width: size, height: thickness }
		: { left: lane, top: offset, width: thickness, height: size };
}
