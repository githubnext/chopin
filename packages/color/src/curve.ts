import { maxChroma } from "./gamut";
import { normalizeHue } from "./oklch";

import type { Oklch } from "./oklch";

export type Easing = "linear" | "ease";
export type Endpoint = { l: number; hueShift: number; easing: Easing };
export type Curve = { darkest: Endpoint; lightest: Endpoint };

/** A cubic Hermite from 0 to 1; "ease" flattens that end's slope to zero. */
export function ease(t: number, start: Easing, end: Easing): number {
	let s0 = start === "ease" ? 0 : 1;
	let s1 = end === "ease" ? 0 : 1;
	let t2 = t * t;
	let t3 = t2 * t;
	return (t3 - 2 * t2 + t) * s0 + (-2 * t3 + 3 * t2) + (t3 - t2) * s1;
}

function lerp(from: number, to: number, t: number): number {
	return from + (to - from) * t;
}

export function curveFrom(base: readonly Oklch[]): Curve {
	if (!base.length) {
		return {
			darkest: { l: 0, hueShift: 0, easing: "linear" },
			lightest: { l: 0, hueShift: 0, easing: "linear" },
		};
	}
	let lightness = base.map(value => value.l);
	return {
		darkest: { l: Math.min(...lightness), hueShift: 0, easing: "linear" },
		lightest: { l: Math.max(...lightness), hueShift: 0, easing: "linear" },
	};
}

/** Generated from the base row, never the edited one, so repeating a setting is idempotent. */
export function rampCurve(base: readonly Oklch[], curve: Curve): Oklch[] {
	if (base.length < 2) return base.map(value => ({ ...value }));
	let lightFirst = base[0].l >= base[base.length - 1].l;
	return base.map((value, index) => {
		let t = (lightFirst ? base.length - 1 - index : index) / (base.length - 1);
		let l = lerp(
			curve.darkest.l,
			curve.lightest.l,
			ease(t, curve.darkest.easing, curve.lightest.easing),
		);
		let h = normalizeHue(value.h + lerp(curve.darkest.hueShift, curve.lightest.hueShift, t));
		let limit = maxChroma(value.l, value.h);
		let ratio = limit > 0 ? Math.min(1, value.c / limit) : 0;
		return { l, c: ratio * maxChroma(l, h), h };
	});
}
