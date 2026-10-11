import { describe, expect, it } from "bun:test";

import {
	childMotionStyle,
	clipInset,
	motionOrigin,
	pileLayout,
	rectTransform,
	settledBox,
	zoomStart,
} from "./child-motion";

let panel = { left: 100, top: 50, width: 800, height: 600 };

describe("child motion origin", () => {
	it("uses an opener whose centre is in the panel, clamped to it", () => {
		expect(motionOrigin({ left: 150, top: 300, width: 400, height: 80 }, panel))
			.toEqual({ left: 150, top: 300, width: 400, height: 80 });
		expect(motionOrigin({ left: 80, top: 600, width: 400, height: 80 }, panel))
			.toEqual({ left: 100, top: 600, width: 380, height: 50 });
	});

	it("falls back to the lower centre for a sidebar row, a hidden opener, or none", () => {
		let fallback = { left: 300, top: 530, width: 400, height: 120 };
		expect(motionOrigin(undefined, panel)).toEqual(fallback);
		expect(motionOrigin({ left: 0, top: 200, width: 90, height: 28 }, panel)).toEqual(fallback);
		expect(motionOrigin({ left: 0, top: 0, width: 0, height: 0 }, panel)).toEqual(fallback);
	});
});

describe("child motion geometry", () => {
	it("clips an element at `box` down to `rect`, never with negative insets", () => {
		expect(clipInset({ left: 150, top: 300, width: 400, height: 80 }, panel, "12px"))
			.toBe("inset(250px 350px 270px 50px round 12px)");
		expect(clipInset({ left: 0, top: 0, width: 2000, height: 2000 }, panel, "0px"))
			.toBe("inset(0px 0px 0px 0px round 0px)");
	});

	it("maps a box laid out at `to` onto `from` from the top left", () => {
		expect(rectTransform({ left: 150, top: 300, width: 400, height: 60 }, panel))
			.toBe("translate(50px, 250px) scale(0.5, 0.1)");
	});

	it("starts a zoom at the opener with a uniform scale and a matching bottom clip", () => {
		expect(zoomStart({ left: 300, top: 240, width: 200, height: 50 }, panel, "12px")).toEqual({
			transform: "translate(200px, 190px) scale(0.25)",
			clipPath: "inset(0px 0px 400px 0px round calc(12px / 0.25))",
		});
	});

	it("finds where a slot lands once a receding parent returns to scale 1", () => {
		// The parent is at scale 0.97 about its top centre (500, 50).
		let pivot = { x: 500, y: 50 };
		let seen = { left: 209, top: 341, width: 388, height: 77.6 };
		let settled = settledBox(seen, 0.97, pivot);
		expect(settled.left).toBeCloseTo(200, 5);
		expect(settled.top).toBeCloseTo(350, 5);
		expect(settled.width).toBeCloseTo(400, 5);
		expect(settled.height).toBeCloseTo(80, 5);
		expect(settledBox(seen, 1, pivot)).toEqual(seen);
	});

	it("stacks cards so only each covered card's bar peeks", () => {
		// Root bar 46px, card bar 36px.
		expect(pileLayout(0, 1, 46, 36)).toEqual({ top: 0, scale: 0.97 });
		expect(pileLayout(1, 1, 46, 36)).toEqual({ top: 46, scale: 1 });
		expect(pileLayout(2, 3, 46, 36)).toEqual({ top: 82, scale: 0.97 });
		expect(pileLayout(0, 3, 46, 36)).toEqual({ top: 0, scale: 0.91 });
	});
});

describe("child motion style", () => {
	it("honours Zoom only where the toggle is enabled", () => {
		expect(childMotionStyle(true, "zoom")).toBe("zoom");
		expect(childMotionStyle(true, "lift")).toBe("lift");
		expect(childMotionStyle(false, "zoom")).toBe("lift");
		expect(childMotionStyle(true, null)).toBe("lift");
		expect(childMotionStyle(true, "wobble")).toBe("lift");
	});
});
