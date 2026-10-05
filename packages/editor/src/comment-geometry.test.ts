import { expect, test } from "bun:test";

import {
	blockMarkerPoints,
	decisionPanelPoint,
	edgePanelPoint,
	marginPoint,
	markerRect,
	popoverPoint,
} from "./comment-geometry";

import type { BlockMarker, Rect } from "./comment-geometry";

const host = {
	top: 100,
	right: 900,
	bottom: 700,
	left: 100,
	width: 800,
	height: 600,
};

function block(top: number, height: number, right = 700): Rect {
	return { top, right, bottom: top + height, left: 200, width: right - 200, height };
}

function marker(top: number, height: number, extra: Partial<BlockMarker> = {}): BlockMarker {
	return { block: block(top, height), line: { top, height: 24 }, width: 24, ...extra };
}

test("places one marker in the right gutter, centred on the block's first line", () => {
	let [point] = blockMarkerPoints([
		{ block: block(180, 120), line: { top: 180, height: 40 }, width: 24 },
	], host);

	expect(point).toEqual({ top: 88, left: 608, width: 24 });
});

test("places a marker in the gutter however far the passage ends from the margin", () => {
	// A short phrase used to pull its marker into the line, on top of the prose.
	let [point] = blockMarkerPoints([marker(180, 24)], host);

	expect(point!.left + host.left).toBeGreaterThanOrEqual(700);
});

test("gives a grouped marker its wider chip in the gutter", () => {
	let [point] = blockMarkerPoints([marker(180, 24, { width: 36 })], host);

	expect(point).toEqual({ top: 80, left: 608, width: 36 });
});

test("narrows the chip into the content padding when the gutter is too narrow", () => {
	let phone = { top: 0, right: 382, bottom: 800, left: 8, width: 374, height: 800 };
	let [point] = blockMarkerPoints([
		{
			block: { top: 100, right: 366, bottom: 200, left: 24, width: 342, height: 100 },
			line: { top: 100, height: 40 },
			width: 24,
		},
	], phone);

	// 16px of padding holds a 14px chip with a pixel either side, clear of the text.
	expect(point).toEqual({ top: 108, left: 359, width: 14, slim: true });
	expect(point!.left + phone.left).toBeGreaterThanOrEqual(366);
	expect(point!.left + phone.left + point!.width).toBeLessThanOrEqual(phone.right);
});

test("widens a slim chip to its minimum so a two-digit count never clips", () => {
	let phone = { top: 0, right: 382, bottom: 800, left: 8, width: 374, height: 800 };
	let [point] = blockMarkerPoints([
		{
			block: { top: 100, right: 366, bottom: 200, left: 24, width: 342, height: 100 },
			line: { top: 100, height: 40 },
			width: 44,
			minimum: 18,
		},
	], phone);

	// 18px is wider than the padding, so it sits flush with the document's edge.
	expect(point).toEqual({ top: 108, left: 356, width: 18, slim: true });
	expect(point!.left + phone.left + point!.width).toBe(phone.right);
});

test("moves a marker below the one above when short blocks sit close together", () => {
	let points = blockMarkerPoints([marker(180, 16), marker(200, 16)], host);

	expect(points[0]!.top).toBe(80);
	expect(points[1]!.top).toBe(108);
});

test("lets a marker scroll above or below the document with its block", () => {
	let points = blockMarkerPoints([marker(20, 40), marker(760, 40)], host);

	expect(points[0]).toMatchObject({ top: -80, offscreen: true });
	expect(points[1]).toMatchObject({ top: 660, offscreen: true });
});

test("keeps a held marker at the nearest document edge after its block scrolls away", () => {
	let points = blockMarkerPoints([
		marker(20, 40, { held: true }),
		marker(760, 40, { held: true }),
	], host);

	expect(points[0]).toEqual({ top: 0, left: 608, width: 24 });
	expect(points[1]).toEqual({ top: 576, left: 608, width: 24 });
});

test("an off-document marker does not displace a visible one", () => {
	let points = blockMarkerPoints([marker(60, 20), marker(100, 20)], host);

	expect(points[0]!.offscreen).toBe(true);
	expect(points[1]).toEqual({ top: 0, left: 608, width: 24 });
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

test("places a decision marker in the left margin at the paragraph's first line", () => {
	let page = { top: 100, left: 200, right: 1_000, bottom: 900, width: 800, height: 800 };
	let target = { top: 300, left: 260, right: 900, bottom: 360, width: 640, height: 60 };

	expect(marginPoint(target, page, 24, 8)).toEqual({ top: 200, left: 28 });
	expect(marginPoint({ ...target, left: 205 }, page, 24, 8).left).toBe(0);
});

test("places a decision panel below its paragraph, then flips above at the viewport edge", () => {
	let page = { top: 100, left: 200, right: 1_000, bottom: 900, width: 800, height: 800 };
	let target = { top: 300, left: 260, right: 900, bottom: 360, width: 640, height: 60 };

	expect(decisionPanelPoint(target, page, 352, 180)).toEqual({ top: 266, left: 60 });
	expect(decisionPanelPoint({ ...target, top: 780, bottom: 840 }, page, 352, 180))
		.toEqual({ top: 494, left: 60 });
	expect(decisionPanelPoint({ ...target, left: 900 }, page, 352, 180).left).toBe(448);
});
