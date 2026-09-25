import { maxChroma, toSrgb } from "@chopin/color";
import { describe, expect, test } from "bun:test";

import {
	gamutPath,
	gridMove,
	hueGradient,
	hueKey,
	huePosition,
	hueValue,
	placePopover,
	planeImage,
	planeKey,
	planePosition,
	planeValue,
	scrub,
} from "./geometry";

let size = { width: 200, height: 200 };

describe("plane mapping", () => {
	test("maps top to white and bottom to black", () => {
		expect(planeValue({ x: 0, y: 0 }, size, 95, 0.18).l).toBe(1);
		expect(planeValue({ x: 0, y: 200 }, size, 95, 0.18).l).toBe(0);
	});

	test("uses a square-root chroma axis so neutrals are not squeezed", () => {
		let x = planePosition({ l: 0.6681, c: 0.0105, h: 95 }, size, 0.18).x;
		expect(x).toBeGreaterThan(40);
	});

	test("round-trips a point inside the gamut", () => {
		let value = { l: 0.6, c: 0.05, h: 95 };
		let point = planePosition(value, size, 0.18);
		let back = planeValue(point, size, 95, 0.18);
		expect(back.l).toBeCloseTo(0.6, 6);
		expect(back.c).toBeCloseTo(0.05, 6);
	});

	test("clamps dragged chroma to the gamut and points to the plane", () => {
		let value = planeValue({ x: 400, y: -20 }, size, 140, 0.2);
		expect(value.l).toBe(1);
		expect(value.c).toBeLessThanOrEqual(maxChroma(1, 140));
		let edge = planeValue({ x: 200, y: 100 }, size, 140, 0.2);
		expect(toSrgb(edge).inGamut).toBe(true);
	});
});

describe("plane image", () => {
	test("is opaque in gamut and transparent outside", () => {
		let pixels = planeImage(140, 0.2, 8);
		expect(pixels.length).toBe(8 * 8 * 4);
		let alpha = (x: number, y: number) => pixels[(y * 8 + x) * 4 + 3];
		expect(alpha(0, 4)).toBe(255);
		expect(alpha(7, 0)).toBe(0);
	});

	test("draws a boundary path from top to bottom", () => {
		let path = gamutPath(95, 0.18, { width: 100, height: 100 }, 4);
		expect(path.startsWith("M ")).toBe(true);
		expect(path.split(" L ").length).toBe(5);
	});
});

describe("plane keyboard", () => {
	let value = { l: 0.6, c: 0.05, h: 95 };

	test("steps chroma horizontally and lightness vertically", () => {
		expect(planeKey(value, "ArrowRight", {})!.c).toBeCloseTo(0.051, 6);
		expect(planeKey(value, "ArrowUp", {})!.l).toBeCloseTo(0.61, 6);
		expect(planeKey(value, "ArrowUp", { shiftKey: true })!.l).toBeCloseTo(0.7, 6);
		expect(planeKey(value, "ArrowLeft", { altKey: true })!.c).toBeCloseTo(0.0499, 6);
		expect(planeKey(value, "PageDown", {})!.l).toBeCloseTo(0.5, 6);
	});

	test("clamps and ignores other keys", () => {
		expect(planeKey({ l: 0.6, c: 0, h: 95 }, "ArrowLeft", {})!.c).toBe(0);
		expect(planeKey({ l: 0.995, c: 0, h: 95 }, "ArrowUp", {})!.l).toBe(1);
		expect(planeKey(value, "a", {})).toBeNull();
	});
});

describe("hue strip", () => {
	test("puts 360 at the top and 0 at the bottom", () => {
		expect(hueValue(0, 200)).toBe(360);
		expect(hueValue(200, 200)).toBe(0);
		expect(huePosition(90, 200)).toBe(150);
	});

	test("round-trips the strip endpoints without moving 360 to the bottom", () => {
		expect(huePosition(hueValue(0, 200), 200)).toBe(0);
		expect(huePosition(hueValue(200, 200), 200)).toBe(200);
	});

	test("ArrowUp increases and wraps", () => {
		expect(hueKey(95, "ArrowUp", {})).toBe(96);
		expect(hueKey(95, "ArrowDown", { shiftKey: true })).toBe(85);
		expect(hueKey(359.5, "ArrowUp", {})).toBe(0.5);
		expect(hueKey(95, "Enter", {})).toBeNull();
	});

	test("paints 25 stops from bottom to top", () => {
		let gradient = hueGradient();
		expect(gradient.startsWith("linear-gradient(to top, #")).toBe(true);
		expect(gradient.match(/#[0-9a-f]{6}/g)!.length).toBe(25);
	});
});

describe("gridMove", () => {
	let lengths = [13, 12, 12];

	test("moves within a row without wrapping", () => {
		expect(gridMove(lengths, { row: 0, index: 0 }, "ArrowRight")).toEqual({ row: 0, index: 1 });
		expect(gridMove(lengths, { row: 0, index: 12 }, "ArrowRight")).toEqual({ row: 0, index: 12 });
		expect(gridMove(lengths, { row: 0, index: 0 }, "ArrowLeft")).toEqual({ row: 0, index: 0 });
		expect(gridMove(lengths, { row: 1, index: 5 }, "End")).toEqual({ row: 1, index: 11 });
		expect(gridMove(lengths, { row: 1, index: 5 }, "Home")).toEqual({ row: 1, index: 0 });
	});

	test("maps proportionally between rows of different lengths", () => {
		expect(gridMove(lengths, { row: 0, index: 12 }, "ArrowDown")).toEqual({ row: 1, index: 11 });
		expect(gridMove(lengths, { row: 1, index: 11 }, "ArrowUp")).toEqual({ row: 0, index: 12 });
		expect(gridMove(lengths, { row: 2, index: 3 }, "ArrowDown")).toEqual({ row: 2, index: 3 });
		expect(gridMove([1, 5], { row: 0, index: 0 }, "ArrowDown")).toEqual({ row: 1, index: 0 });
	});

	test("skips empty rows and ignores other keys", () => {
		expect(gridMove([3, 0, 3], { row: 0, index: 1 }, "ArrowDown")).toEqual({ row: 2, index: 1 });
		expect(gridMove(lengths, { row: 0, index: 0 }, "Tab")).toBeNull();
	});
});

describe("placePopover", () => {
	let viewport = { left: 0, top: 0, width: 1000, height: 800 };
	let size = { width: 320, height: 500 };

	test("centres below the anchor", () => {
		expect(placePopover({ left: 400, top: 100, width: 60, height: 40 }, size, viewport)).toEqual({
			left: 270,
			top: 148,
			side: "below",
		});
	});

	test("flips above when there is no room below", () => {
		expect(placePopover({ left: 400, top: 700, width: 60, height: 40 }, size, viewport)).toEqual({
			left: 270,
			top: 192,
			side: "above",
		});
	});

	test("clamps horizontally with a 16px margin, including viewport offsets", () => {
		expect(placePopover({ left: 0, top: 100, width: 40, height: 40 }, size, viewport).left)
			.toBe(16);
		let narrow = { left: 50, top: 0, width: 300, height: 800 };
		expect(placePopover({ left: 150, top: 100, width: 40, height: 40 }, size, narrow).left)
			.toBe(66);
	});

	test("chooses the roomier side when neither fits", () => {
		let short = { left: 0, top: 0, width: 1000, height: 400 };
		expect(placePopover({ left: 400, top: 300, width: 60, height: 40 }, size, short).side)
			.toBe("above");
		expect(placePopover({ left: 400, top: 40, width: 60, height: 40 }, size, short).side)
			.toBe("below");
	});

	test("keeps a roomier below placement within the viewport when neither side fits", () => {
		let placed = placePopover({ left: 400, top: 340, width: 60, height: 40 }, size, viewport);
		expect(placed).toEqual({ left: 270, top: 284, side: "below" });
	});

	test("pins an oversized popover to the top margin", () => {
		let offset = { left: 0, top: 50, width: 1000, height: 800 };
		let oversized = { width: 320, height: 900 };
		let placed = placePopover({ left: 400, top: 390, width: 60, height: 40 }, oversized, offset);
		expect(placed.top).toBe(66);
	});
});

test("scrub steps per pixel run and clamps", () => {
	expect(scrub(50, 8, { step: 1, min: 0, max: 100 })).toBe(52);
	expect(scrub(50, -3, { step: 1, min: 0, max: 100 })).toBe(49);
	expect(scrub(99, 40, { step: 1, min: 0, max: 100 })).toBe(100);
	expect(scrub(0, 12, { step: 5, min: -180, max: 180, pixelsPerStep: 6 })).toBe(10);
});
