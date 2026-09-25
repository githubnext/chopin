import { describe, expect, test } from "bun:test";

import { cusp, maxChroma } from "./gamut";
import { toSrgb } from "./oklch";

describe("maxChroma", () => {
	test("finds the sRGB boundary", () => {
		expect(maxChroma(0.7, 30)).toBeCloseTo(0.1915, 3);
		expect(maxChroma(0.75, 95)).toBeCloseTo(0.154, 3);
	});

	test("is in gamut at the result and out just beyond it", () => {
		for (let [l, h] of [[0.3, 260], [0.6, 140], [0.9, 95]] as const) {
			let c = maxChroma(l, h);
			expect(toSrgb({ l, c, h }).inGamut).toBe(true);
			expect(toSrgb({ l, c: c + 0.002, h }).inGamut).toBe(false);
		}
	});

	test("collapses to zero at white and black", () => {
		expect(maxChroma(1, 0)).toBeLessThan(0.001);
		expect(maxChroma(0, 200)).toBe(0);
	});
});

test("cusp is the largest maxChroma across lightness", () => {
	expect(cusp(95)).toBeCloseTo(0.1807, 3);
});
