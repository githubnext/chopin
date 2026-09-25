import { describe, expect, test } from "bun:test";

import { curveFrom, ease, rampCurve } from "./curve";
import { maxChroma } from "./gamut";

let lightToDark = [
	{ l: 0.95, c: 0.02, h: 30 },
	{ l: 0.8, c: 0.08, h: 30 },
	{ l: 0.6, c: 0.15, h: 31 },
	{ l: 0.4, c: 0.1, h: 32 },
];

describe("ease", () => {
	test("linear at both ends is the identity", () => {
		for (let t of [0, 0.25, 0.5, 1]) expect(ease(t, "linear", "linear")).toBeCloseTo(t, 9);
	});

	test("ease flattens its end and stays monotonic", () => {
		expect(ease(0.1, "ease", "linear")).toBeLessThan(0.1);
		expect(ease(0.9, "linear", "ease")).toBeGreaterThan(0.9);
		let previous = -1;
		for (let step = 0; step <= 20; step++) {
			let value = ease(step / 20, "ease", "ease");
			expect(value).toBeGreaterThanOrEqual(previous);
			previous = value;
		}
	});
});

describe("rampCurve", () => {
	test("curveFrom spans the row's lightness with no shift", () => {
		expect(curveFrom(lightToDark)).toEqual({
			darkest: { l: 0.4, hueShift: 0, easing: "linear" },
			lightest: { l: 0.95, hueShift: 0, easing: "linear" },
		});
	});

	test("respects declared order: the first swatch is lightest here", () => {
		let out = rampCurve(lightToDark, {
			darkest: { l: 0.3, hueShift: 0, easing: "linear" },
			lightest: { l: 0.9, hueShift: 0, easing: "linear" },
		});
		expect(out.map(value => Number(value.l.toFixed(4)))).toEqual([0.9, 0.7, 0.5, 0.3]);
	});

	test("shifts hue from each swatch's own base hue", () => {
		let out = rampCurve(lightToDark, {
			darkest: { l: 0.4, hueShift: -30, easing: "linear" },
			lightest: { l: 0.95, hueShift: 0, easing: "linear" },
		});
		expect(out[0].h).toBeCloseTo(30, 6);
		expect(out[3].h).toBeCloseTo(2, 6);
	});

	test("keeps each swatch's relative chroma and stays in gamut", () => {
		let out = rampCurve(lightToDark, curveFrom(lightToDark));
		for (let [index, value] of out.entries()) {
			let base = lightToDark[index];
			let ratio = Math.min(1, base.c / maxChroma(base.l, base.h));
			expect(value.c).toBeCloseTo(ratio * maxChroma(value.l, value.h), 6);
		}
	});

	test("handles achromatic rows and rows too short to curve", () => {
		let grays = [{ l: 0.9, c: 0, h: 0 }, { l: 0.2, c: 0, h: 0 }];
		expect(rampCurve(grays, curveFrom(grays)).every(value => value.c === 0)).toBe(true);
		expect(rampCurve([{ l: 0.5, c: 0.1, h: 30 }], curveFrom([{ l: 0.5, c: 0.1, h: 30 }]))).toEqual([
			{ l: 0.5, c: 0.1, h: 30 },
		]);
	});
});
