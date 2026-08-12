import { expect, test } from "bun:test";

import { gutterPoint, popoverPoint } from "./comment-geometry";

const host = {
	top: 100,
	right: 900,
	bottom: 700,
	left: 100,
	width: 800,
	height: 600,
};

test("places a gutter button beside the first line of an exact passage", () => {
	let point = gutterPoint({
		top: 180,
		right: 520,
		bottom: 200,
		left: 340,
		width: 180,
		height: 20,
	}, host);

	expect(point).toEqual({ top: 80, left: 428 });
});

test("places a gutter button at the top of a surviving block", () => {
	let point = gutterPoint({
		top: 320,
		right: 520,
		bottom: 420,
		left: 340,
		width: 180,
		height: 100,
	}, host);

	expect(point).toEqual({ top: 220, left: 428 });
});

test("clamps a gutter button inside the document", () => {
	let point = gutterPoint({
		top: 90,
		right: 1_000,
		bottom: 110,
		left: 950,
		width: 50,
		height: 20,
	}, host);

	expect(point).toEqual({ top: 0, left: 776 });
});

test("places a popover to the left when the right side lacks room", () => {
	let point = popoverPoint(
		{
			top: 260,
			right: 884,
			bottom: 284,
			left: 860,
			width: 24,
			height: 24,
		},
		host,
		320,
		24,
	);

	expect(point).toEqual({ top: 160, left: 432 });
});

test("keeps a tall popover inside the document bottom edge", () => {
	let point = popoverPoint(
		{
			top: 660,
			right: 560,
			bottom: 684,
			left: 536,
			width: 24,
			height: 24,
		},
		host,
		320,
		200,
	);

	expect(point).toEqual({ top: 400, left: 468 });
});
