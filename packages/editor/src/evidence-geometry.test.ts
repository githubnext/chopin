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

	it("clamps both axes when neither side fits, using the measured panel size", () => {
		let small = { width: 700, height: 500 };
		let point = evidencePoint({ ...card, top: 460, left: 40, right: 660 }, small, 510, 420);
		expect(point).toEqual({ top: 68, left: 178, side: "right" });
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
