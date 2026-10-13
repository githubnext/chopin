// Layout for a chart drawn to a narrow column instead of scaled down to it.
// Text keeps one legible size; marks, gaps and how many labels are shown give way.
import { DIAGRAM_TYPE } from "../../tokens.mjs";

/** Every label in a fitted chart, in CSS pixels; `.sc-fitted` sets the same size. */
export const FITTED_TEXT = DIAGRAM_TYPE.sub.size;

/** Room a fitted chart needs between neighbouring labels. */
const LABEL_GAP = 8;

/**
 * Which labels along an axis to draw so none collide: every k-th, from the
 * first, with the smallest k that clears. The last label replaces the one
 * before it when both cannot stand, so the axis always shows where it ends.
 */
export function thinLabels(positions, widths, gap = LABEL_GAP) {
	let count = positions.length;
	if (count < 2) return positions.map((_, index) => index);
	let clear = (a, b) => Math.abs(positions[b] - positions[a]) >= (widths[a] + widths[b]) / 2 + gap;
	for (let stride = 1; stride < count; stride++) {
		let kept = [];
		for (let index = 0; index < count; index += stride) kept.push(index);
		if (!kept.slice(1).every((index, k) => clear(kept[k], index))) continue;
		let last = count - 1;
		if (kept.at(-1) !== last) {
			if (!clear(kept.at(-1), last)) kept.pop();
			if (!kept.length || clear(kept.at(-1), last)) kept.push(last);
		}
		return kept;
	}
	return [0];
}

/**
 * Bands for `count` categories across `length`: each slot, and the share of it
 * the bars take. Bars keep at least a 4px gap between neighbours.
 */
export function bands(count, length) {
	let slot = length / Math.max(1, count);
	let group = Math.max(1, Math.min(slot * 0.62, slot - 4));
	return { slot, group };
}

/** Move a label centred at `x`, `width` wide, inward until it sits within [lo, hi]. */
export function clampCentre(x, width, lo, hi) {
	return Math.min(hi - width / 2, Math.max(lo + width / 2, x));
}

/**
 * The labels to draw along an axis from `lo` to `hi`, and where: each is moved
 * inside the axis first, then thinned, so the moved ones never collide.
 */
export function axisLabels(positions, widths, lo, hi) {
	let placed = positions.map((x, i) => clampCentre(x, widths[i], lo, hi));
	return thinLabels(placed, widths).map(index => ({ index, x: placed[index] }));
}
