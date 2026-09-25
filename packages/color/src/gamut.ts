import { toSrgb } from "./oklch";

/** The most chroma sRGB can show at this lightness and hue; a bisection, so ±3e-8. */
export function maxChroma(l: number, h: number): number {
	if (l <= 0 || l >= 1) return 0;
	let low = 0;
	let high = 0.5;
	for (let step = 0; step < 24; step++) {
		let middle = (low + high) / 2;
		if (toSrgb({ l, c: middle, h }).inGamut) low = middle;
		else high = middle;
	}
	return low;
}

/** The peak of the gamut boundary for one hue; sets the plane's chroma range. */
export function cusp(h: number): number {
	let peak = 0;
	for (let step = 1; step < 100; step++) peak = Math.max(peak, maxChroma(step / 100, h));
	return peak;
}
