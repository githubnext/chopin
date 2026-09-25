import { describe, expect, test } from "bun:test";

import { contrast, formatRatio, formatThreshold, passes, PURPOSES, THRESHOLDS } from "./contrast";

let white = { l: 1, c: 0, h: 0 };

describe("contrast", () => {
	test("matches WCAG extremes and Chopin's grays against white", () => {
		expect(contrast(white, { l: 0, c: 0, h: 0 })).toBeCloseTo(21, 6);
		expect(contrast({ l: 0.89108, c: 0.00552, h: 95 }, white)).toBeCloseTo(1.3855, 3);
		expect(contrast({ l: 0.74029, c: 0.00856, h: 95 }, white)).toBeCloseTo(2.302, 3);
		expect(contrast({ l: 0.6681, c: 0.0105, h: 95 }, white)).toBeCloseTo(3.0058, 3);
		expect(contrast({ l: 0.56514, c: 0.0123, h: 95 }, white)).toBeCloseTo(4.5502, 3);
	});

	test("is symmetric", () => {
		let gray = { l: 0.6681, c: 0.0105, h: 95 };
		expect(contrast(gray, white)).toBe(contrast(white, gray));
	});
});

describe("thresholds", () => {
	test("compare the unrounded ratio", () => {
		expect(passes(2.9999, "graphic")).toBe(false);
		expect(passes(3, "graphic")).toBe(true);
		expect(passes(4.49, "text")).toBe(false);
		expect(THRESHOLDS.enhanced).toBe(7);
		expect(PURPOSES).toEqual(["graphic", "large", "text", "enhanced"]);
	});

	test("format ratios by truncation without float error", () => {
		expect(formatRatio(2.9999)).toBe("2.99:1");
		expect(formatRatio(1.15)).toBe("1.15:1");
		expect(formatRatio(3.0058)).toBe("3.00:1");
		expect(formatRatio(21)).toBe("21.00:1");
		expect(formatThreshold("text")).toBe("4.5:1");
		expect(formatThreshold("graphic")).toBe("3:1");
	});
});
