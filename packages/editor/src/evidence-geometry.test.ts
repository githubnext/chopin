import { describe, expect, it } from "bun:test";

import { evidencePoint, pointerOverCard } from "./evidence-geometry";

let viewport = { width: 1_440, height: 900 };
let card = { top: 200, left: 600, right: 1_000, bottom: 420, width: 400, height: 220 };

describe("evidencePoint", () => {
	it("opens to the right when the panel fits", () => {
		expect(evidencePoint(card, viewport, 320, 300)).toEqual({
			top: 200,
			left: 1_008,
			side: "right",
		});
	});

	it("uses the left side when the right is full", () => {
		let nearEdge = { ...card, left: 700, right: 1_300 };
		expect(evidencePoint(nearEdge, viewport, 320, 300)).toEqual({
			top: 200,
			left: 372,
			side: "left",
		});
	});

	it("opens below, then above, the card when neither side fits", () => {
		let small = { width: 700, height: 900 };
		let wide = { ...card, top: 100, bottom: 300, left: 40, right: 660 };
		expect(evidencePoint(wide, small, 320, 300)).toEqual({ top: 308, left: 40, side: "below" });
		let low = { ...wide, top: 560, bottom: 860 };
		expect(evidencePoint(low, small, 320, 300)).toEqual({ top: 252, left: 40, side: "above" });
	});

	it("clamps both axes when no side fits, using the measured panel size", () => {
		let small = { width: 700, height: 500 };
		let point = evidencePoint(
			{ ...card, top: 60, bottom: 460, left: 40, right: 660 },
			small,
			510,
			420,
		);
		expect(point).toEqual({ top: 60, left: 178, side: "right" });
	});

	it("uses a bottom sheet on narrow viewports", () => {
		expect(evidencePoint(card, { width: 390, height: 844 }, 320, 300).side).toBe("sheet");
	});

	it("pins an over-tall panel to the top inset", () => {
		expect(evidencePoint(card, { width: 1_440, height: 240 }, 320, 216).top).toBe(12);
	});
});

describe("intentional evidence dismissal", () => {
	it("suppresses an exposed card only when the dismissal pointer overlaps it", () => {
		expect(pointerOverCard(card, { x: 750, y: 300 })).toBe(true);
		expect(pointerOverCard(card, { x: 1_010, y: 300 })).toBe(false);
		expect(pointerOverCard(card, { x: 750, y: 430 })).toBe(false);
		expect(pointerOverCard(card, undefined)).toBe(false);
	});
});
