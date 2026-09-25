import { toSrgb } from "./oklch";

import type { Oklch } from "./oklch";

export type Purpose = "graphic" | "large" | "text" | "enhanced";

export const PURPOSES: readonly Purpose[] = ["graphic", "large", "text", "enhanced"];

export const THRESHOLDS: Record<Purpose, number> = {
	graphic: 3,
	large: 3,
	text: 4.5,
	enhanced: 7,
};

export const PURPOSE_LABELS: Record<Purpose, string> = {
	graphic: "Graphics and UI",
	large: "Large text",
	text: "Body text",
	enhanced: "Enhanced text",
};

export function luminance(value: Oklch): number {
	let { r, g, b } = toSrgb(value);
	let [red, green, blue] = [r, g, b].map(channel => {
		let encoded = channel / 255;
		return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrast(a: Oklch, b: Oklch): number {
	let first = luminance(a);
	let second = luminance(b);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function passes(ratio: number, purpose: Purpose): boolean {
	return ratio >= THRESHOLDS[purpose];
}

/** Truncated, never rounded: WCAG has no rounding, so 2.999 must not read as 3.00. */
export function formatRatio(ratio: number): string {
	let [whole, decimal = ""] = ratio.toString().split(".");
	return `${whole}.${decimal.padEnd(2, "0").slice(0, 2)}:1`;
}

export function formatThreshold(purpose: Purpose): string {
	return `${THRESHOLDS[purpose]}:1`;
}
