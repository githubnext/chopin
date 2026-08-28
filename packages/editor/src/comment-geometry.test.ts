import { expect, test } from "bun:test";

import { edgePanelPoint, markerPoints, markerRect, popoverPoint } from "./comment-geometry";

import type { Rect } from "./comment-geometry";

const host = {
	top: 100,
	right: 900,
	bottom: 700,
	left: 100,
	width: 800,
	height: 600,
};

function place(target: Rect, size = 24, passages = [target]) {
	return markerPoints([{ target, passages }], host, size)[0];
}

test("places a gutter button beside the first line of an exact passage", () => {
	let point = place({
		top: 180,
		right: 520,
		bottom: 200,
		left: 340,
		width: 180,
		height: 20,
	});

	expect(point).toEqual({ top: 80, left: 428 });
});

test("places a gutter button at the top of a surviving block", () => {
	let point = place({
		top: 320,
		right: 520,
		bottom: 420,
		left: 340,
		width: 180,
		height: 100,
	});

	expect(point).toEqual({ top: 220, left: 428 });
});

test("clamps a gutter button inside the document", () => {
	let point = place({
		top: 90,
		right: 1_000,
		bottom: 110,
		left: 950,
		width: 50,
		height: 20,
	});

	expect(point).toEqual({ top: 0, left: 776 });
});

test("moves a coarse gutter button clear of a passage at the right edge", () => {
	let point = place(
		{
			top: 180,
			right: 890,
			bottom: 200,
			left: 700,
			width: 190,
			height: 20,
		},
		44,
	);

	expect(point).toEqual({ top: 108, left: 756 });
});

test("places a tall right-edge passage's marker in the free left gutter", () => {
	let point = place(
		{
			top: 100,
			right: 890,
			bottom: 700,
			left: 700,
			width: 190,
			height: 600,
		},
		44,
	);

	expect(point).toEqual({ top: 0, left: 548 });
});

test("keeps an impossible marker mounted just beyond its passage", () => {
	let point = place(
		{
			top: 100,
			right: 900,
			bottom: 700,
			left: 100,
			width: 800,
			height: 600,
		},
		44,
	);

	expect(point).toEqual({ top: 608, left: 756 });
});

test("finds a safe in-host point between full-height passage columns", () => {
	let narrowHost = {
		top: 0,
		right: 400,
		bottom: 200,
		left: 0,
		width: 400,
		height: 200,
	};
	let target = {
		top: 50,
		right: 250,
		bottom: 100,
		left: 100,
		width: 150,
		height: 50,
	};
	let columns = [
		{ top: 0, right: 100, bottom: 200, left: 0, width: 100, height: 200 },
		{ top: 0, right: 300, bottom: 200, left: 250, width: 50, height: 200 },
		{ top: 0, right: 400, bottom: 200, left: 356, width: 44, height: 200 },
	];
	let passages = [target, ...columns];

	expect(markerPoints([{ target, passages }], narrowHost, 44)[0]).toEqual({
		top: 50,
		left: 304,
	});
	expect(markerPoints([{ target, passages: passages.toReversed() }], narrowHost, 44)[0])
		.toEqual({ top: 50, left: 304 });
});

test("keeps stacked markers clear of both bottom-edge passages", () => {
	let earlier = {
		top: 608,
		right: 900,
		bottom: 652,
		left: 856,
		width: 44,
		height: 44,
	};
	let target = {
		top: 660,
		right: 890,
		bottom: 690,
		left: 700,
		width: 190,
		height: 30,
	};

	expect(markerPoints(
		[
			{ target: earlier, passages: [earlier] },
			{ target, passages: [target] },
		],
		host,
		44,
	)).toEqual([
		{ top: 456, left: 756 },
		{ top: 404, left: 756 },
	]);
});

test("places an earlier marker clear of every later thread passage", () => {
	let earlier = {
		top: 180,
		right: 520,
		bottom: 200,
		left: 340,
		width: 180,
		height: 20,
	};
	let later = {
		top: 180,
		right: 552,
		bottom: 204,
		left: 528,
		width: 24,
		height: 24,
	};

	expect(markerPoints([
		{ target: earlier, passages: [earlier] },
		{ target: later, passages: [later] },
	], host)).toEqual([
		{ top: 108, left: 428 },
		{ top: 80, left: 460 },
	]);
	expect(markerPoints([
		{ target: later, passages: [later] },
		{ target: earlier, passages: [earlier] },
	], host)).toEqual([
		{ top: 80, left: 460 },
		{ top: 108, left: 428 },
	]);
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

test("resolves a marker point into its canonical page rectangle", () => {
	expect(markerRect({ top: 80, left: 428 }, host, 24)).toEqual({
		top: 180,
		right: 552,
		bottom: 204,
		left: 528,
		width: 24,
		height: 24,
	});
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

test("docks a comment panel at the document's right edge", () => {
	let point = edgePanelPoint(
		{ top: 260, right: 560, bottom: 284, left: 536, width: 24, height: 24 },
		host,
		320,
		200,
	);

	expect(point).toEqual({ top: 160, left: 468 });
});

test("keeps an edge panel inside both vertical document edges", () => {
	let above = edgePanelPoint(
		{ top: 50, right: 560, bottom: 74, left: 536, width: 24, height: 24 },
		host,
		320,
		200,
	);
	let below = edgePanelPoint(
		{ top: 660, right: 560, bottom: 684, left: 536, width: 24, height: 24 },
		host,
		320,
		240,
	);

	expect(above).toEqual({ top: 12, left: 468 });
	expect(below).toEqual({ top: 348, left: 468 });
});
