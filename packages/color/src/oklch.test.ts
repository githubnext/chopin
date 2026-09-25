import { describe, expect, test } from "bun:test";

import { format, fromHex, normalizeHue, parse, sameColor, toHex, toSrgb } from "./oklch";

describe("toSrgb", () => {
	test("matches Chopin's documented theme hex values", () => {
		expect(toHex({ l: 0.89108, c: 0.00552, h: 95 })).toBe("#dcdbd7");
		expect(toHex({ l: 0.6681, c: 0.0105, h: 95 })).toBe("#96958e");
		expect(toHex({ l: 0.56514, c: 0.0123, h: 95 })).toBe("#78766e");
		expect(toHex({ l: 1, c: 0, h: 0 })).toBe("#ffffff");
		expect(toHex({ l: 0, c: 0, h: 0 })).toBe("#000000");
	});

	test("flags out-of-gamut colors and clamps their bytes", () => {
		let rgb = toSrgb({ l: 0.7, c: 0.3, h: 140 });
		expect(rgb.inGamut).toBe(false);
		for (let channel of [rgb.r, rgb.g, rgb.b]) {
			expect(channel).toBeGreaterThanOrEqual(0);
			expect(channel).toBeLessThanOrEqual(255);
		}
		expect(toSrgb({ l: 0.6681, c: 0.0105, h: 95 }).inGamut).toBe(true);
	});
});

describe("fromHex", () => {
	test("round-trips a theme gray", () => {
		let value = fromHex("#78766e")!;
		expect(value.l).toBeCloseTo(0.56514, 4);
		expect(value.c).toBeCloseTo(0.0123, 4);
		expect(value.h).toBeCloseTo(95.28, 1);
		expect(toHex(value)).toBe("#78766e");
	});

	test("treats near-zero chroma as achromatic", () => {
		let white = fromHex("#ffffff")!;
		expect(white.l).toBeCloseTo(1, 6);
		expect(white.c).toBe(0);
		expect(white.h).toBe(0);
	});

	test("accepts short hex and rejects anything else", () => {
		expect(toHex(fromHex("#fff")!)).toBe("#ffffff");
		expect(fromHex("#ffff")).toBeNull();
		expect(fromHex("ffffff")).toBeNull();
		expect(fromHex("#gggggg")).toBeNull();
	});
});

describe("parse", () => {
	test("reads oklch() with numbers, percentages, deg and none", () => {
		expect(parse("oklch(0.6681 0.0105 95)")).toEqual({ l: 0.6681, c: 0.0105, h: 95 });
		expect(parse("  OKLCH( 66.81%  0.0105  95deg )")).toEqual({ l: 0.6681, c: 0.0105, h: 95 });
		expect(parse("oklch(0.5 50% 30)")).toEqual({ l: 0.5, c: 0.2, h: 30 });
		expect(parse("oklch(0.5 0.1 none)")).toEqual({ l: 0.5, c: 0.1, h: 0 });
	});

	test("clamps like CSS and normalizes hue", () => {
		expect(parse("oklch(1.5 -0.1 -30)")).toEqual({ l: 1, c: 0, h: 330 });
	});

	test("rejects non-finite percentage channels", () => {
		expect(parse("oklch(0.5 1e309% 30)")).toBeNull();
	});

	test("delegates hex", () => {
		expect(toHex(parse("#96958E")!)).toBe("#96958e");
	});

	test("rejects alpha, var(), other functions and garbage", () => {
		for (
			let text of [
				"oklch(0.5 0.1 30 / 50%)",
				"oklch(var(--x) 0.1 30)",
				"rgb(1 2 3)",
				"oklch(0.5, 0.1, 30)",
				"oklch(0.5 0.1)",
				"",
				"blue",
			]
		) {
			expect(parse(text)).toBeNull();
		}
	});
});

describe("format", () => {
	test("writes trimmed oklch() and lowercase hex", () => {
		expect(format({ l: 0.6681, c: 0.0105, h: 95 }, "oklch")).toBe("oklch(0.6681 0.0105 95)");
		expect(format({ l: 0.123456789, c: 0.000001, h: 12.3456 }, "oklch")).toBe(
			"oklch(0.12346 0 12.35)",
		);
		expect(format({ l: 0.6681, c: 0.0105, h: 95 }, "hex")).toBe("#96958e");
	});

	test("formats a hue that rounds to 360 as 0", () => {
		expect(format({ l: 0.5, c: 0.1, h: 359.999 }, "oklch")).toBe("oklch(0.5 0.1 0)");
	});
});

describe("sameColor and normalizeHue", () => {
	test("compares within 1e-5 and ignores hue for achromatic pairs", () => {
		expect(sameColor({ l: 0.5, c: 0.1, h: 30 }, { l: 0.500001, c: 0.1, h: 30 })).toBe(true);
		expect(sameColor({ l: 0.5, c: 0.1, h: 30 }, { l: 0.5, c: 0.1, h: 31 })).toBe(false);
		expect(sameColor({ l: 0.5, c: 0, h: 30 }, { l: 0.5, c: 0.000005, h: 200 })).toBe(true);
	});

	test("wraps hue into [0, 360)", () => {
		expect(normalizeHue(-30)).toBe(330);
		expect(normalizeHue(720)).toBe(0);
		expect(normalizeHue(95)).toBe(95);
	});
});
