import { expect, test } from "bun:test";

import { intersectViewport, placeSurface } from "./placement";

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
