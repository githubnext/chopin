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

test("fits a full preview beside a gutter button in a 400px document", () => {
	let point = popoverPoint(
		{
			top: 300,
			right: 492,
			bottom: 324,
			left: 468,
			width: 24,
			height: 24,
		},
		{
			top: 100,
			right: 500,
			bottom: 700,
			left: 100,
			width: 400,
			height: 600,
		},
		288,
		96,
	);

	// 400px can hold either a 288px preview or its gutter button, but not both
	// on the right. Keeping the preview inside the page means using the left.
	expect(point).toEqual({ top: 200, left: 72 });
});
