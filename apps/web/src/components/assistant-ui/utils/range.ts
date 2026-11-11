export function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** The first `count` items, for a `count` that may be out of range. */
export function take<T>(items: readonly T[], count: number) {
  return items.slice(0, Math.floor(clamp(count, 0, items.length)));
}

/** The position `index` names in `items`, for an `index` out of range. */
export function indexIn<T>(items: readonly T[], index: number) {
  return Math.floor(clamp(index, 0, Math.max(0, items.length - 1)));
}

/** The item at `index`, for an `index` that may be out of range. */
export function at<T>(items: readonly T[], index: number) {
  if (items.length === 0) return undefined;
  return items[indexIn(items, index)];
}

/** `value` as a share of `total`, as a percentage in `0…100`. */
export function pct(value: number, total: number) {
  if (!(total > 0)) return 0;
  return clamp((value / total) * 100, 0, 100);
}

/**
 * A `0…100` share as it should be announced. `pct` divides, so a share that
 * reads as a whole number on screen can still reach `aria-valuenow` carrying
 * float error, which a screen reader reads out in full.
 */
export function announced(share: number) {
  return Math.round(share * 10) / 10;
}

/** A count of completed items out of `total`, in `0…total`. */
export function progressOf(index: number, total: number) {
  if (!(total > 0)) return 0;
  return Math.floor(clamp(index, 0, total));
}
