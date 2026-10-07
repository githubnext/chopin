import { expect, test } from "bun:test";

import { intersectViewport, placeDraft, placeSurface, visibleAnchor } from "./placement";

test("intersects the visual viewport with the editor host", () => {
	expect(
		intersectViewport(
			{ left: 10, top: 20, width: 390, height: 500 },
			{ left: 30, right: 350, top: 0, bottom: 460, width: 320, height: 460 },
		),
	).toEqual({ left: 30, top: 20, width: 320, height: 440 });
});

test("keeps a menu inside an offset visual viewport", () => {
	expect(
		placeSurface(
			{ left: 382, right: 382, top: 790, bottom: 810, width: 0, height: 20 },
			{ width: 224, height: 288 },
			{ left: 0, top: 280, width: 390, height: 500 },
		),
	).toEqual({ left: 158, top: 494, maxHeight: 278 });
});

test("clamps a surface at the left and top edges", () => {
	expect(
		placeSurface(
			{ left: -20, right: 0, top: -12, bottom: 8, width: 20, height: 20 },
			{ width: 224, height: 288 },
			{ left: 0, top: 0, width: 390, height: 844 },
		),
	).toEqual({ left: 8, top: 16, maxHeight: 288 });
});

test("places a surface above an anchor at the right and bottom edges", () => {
	expect(
		placeSurface(
			{ left: 380, right: 390, top: 820, bottom: 840, width: 10, height: 20 },
			{ width: 224, height: 200 },
			{ left: 0, top: 0, width: 390, height: 844 },
		),
	).toEqual({ left: 158, top: 612, maxHeight: 200 });
});

test("bounds an over-tall surface to the room below its anchor", () => {
	expect(
		placeSurface(
			{ left: 80, right: 120, top: 400, bottom: 420, width: 40, height: 20 },
			{ width: 224, height: 1_000 },
			{ left: 0, top: 0, width: 390, height: 844 },
		),
	).toEqual({ left: 80, top: 428, maxHeight: 408 });
});

test("prefers above a selection and flips below only without room", () => {
	let viewport = { left: 0, top: 0, width: 800, height: 600 };
	let surface = { width: 200, height: 36 };
	let near = { left: 100, right: 300, top: 300, bottom: 320, width: 200, height: 20 };
	// Auto would pick below here; the bubble stays over the selection.
	let roomy = { ...near, top: 100, bottom: 120 };
	expect(placeSurface(roomy, surface, viewport, 8, "above").top).toBe(56);
	expect(placeSurface({ ...roomy, top: 400, bottom: 420 }, surface, viewport, 8, "above").top).toBe(
		356,
	);
	let cramped = { ...near, top: 30, bottom: 50 };
	expect(placeSurface(cramped, surface, viewport, 8, "above").top).toBe(58);
});

test("clamps a preferred-above surface horizontally", () => {
	let placed = placeSurface(
		{ left: 700, right: 790, top: 300, bottom: 320, width: 90, height: 20 },
		{ width: 200, height: 36 },
		{ left: 0, top: 0, width: 800, height: 600 },
		8,
		"above",
	);
	expect(placed).toEqual({ left: 592, top: 256, maxHeight: 36 });
});

test("hides an anchor that has mostly scrolled out and clips a tall one", () => {
	let viewport = { left: 0, top: 100, width: 800, height: 400 };
	let anchor = (top: number, bottom: number) => ({
		left: 0,
		right: 100,
		top,
		bottom,
		width: 100,
		height: bottom - top,
	});
	expect(visibleAnchor(anchor(200, 220), viewport)).toEqual(anchor(200, 220));
	expect(visibleAnchor(anchor(60, 105), viewport)).toBeUndefined();
	expect(visibleAnchor(anchor(520, 540), viewport)).toBeUndefined();
	expect(visibleAnchor(anchor(0, 1000), viewport)).toEqual(anchor(100, 500));
});

const BOUNDS = { left: 760, top: 96, width: 660, height: 790 };
const DRAFT = { width: 450, height: 150 };

function block(top: number, height = 26, left = 827) {
	return { left, right: left + 540, top, bottom: top + height, width: 540, height };
}

test("places a draft directly under its anchor block when it fits", () => {
	expect(placeDraft(block(300), DRAFT, BOUNDS)).toEqual({
		left: 827,
		top: 326,
		side: "below",
		reveal: 0,
	});
});

test("asks to reveal a draft whose anchor sits above the visible scroller", () => {
	let placement = placeDraft(block(-85), DRAFT, BOUNDS);
	expect(placement.side).toBe("away");
	expect(placement.reveal).toBe(-85 + 2 - 104);
	// After that scroll, the last anchor line sits at the top edge and the draft below it.
	expect(placeDraft(block(-85 - placement.reveal), DRAFT, BOUNDS).side).toBe("below");
});

test("asks to reveal a draft that would run past the bottom edge", () => {
	let placement = placeDraft(block(760), DRAFT, BOUNDS);
	expect(placement.reveal).toBe(786 + 150 - 878);
	expect(placeDraft(block(760 - placement.reveal), DRAFT, BOUNDS)).toMatchObject({
		side: "below",
		reveal: 0,
	});
});

test("tolerates the sub-pixel remainder a whole-pixel scroll leaves", () => {
	expect(placeDraft(block(702.5), DRAFT, BOUNDS).side).toBe("below");
});

test("flips above the anchor when the bottom edge leaves no room", () => {
	expect(placeDraft(block(760), DRAFT, BOUNDS)).toMatchObject({ side: "above", top: 610 });
});

test("pins inside a short visual viewport where neither side fits", () => {
	let keyboard = { left: 0, top: 0, width: 390, height: 160 };
	let placement = placeDraft(block(120, 26, 20), { width: 350, height: 150 }, keyboard);
	expect(placement).toMatchObject({ side: "pinned", top: 8, left: 20 });
	expect(placement.reveal).toBe(122 - 8);
});

test("reveals only enough to fit a draft above the keyboard", () => {
	let keyboard = { left: 0, top: 0, width: 390, height: 260 };
	let placement = placeDraft(block(120, 26, 20), { width: 350, height: 150 }, keyboard);
	expect(placement.reveal).toBe(146 + 150 - 252);
});

test("keeps a draft inside narrow bounds horizontally", () => {
	expect(placeDraft(block(300, 26, 1100), DRAFT, BOUNDS).left).toBe(1420 - 8 - 450);
});
