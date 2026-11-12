import { expect, test } from "bun:test";

import {
	arrowStep,
	clampPan,
	detailLine,
	downloadName,
	fileNameOf,
	fitScale,
	pinch,
	relativeTime,
	scaleOf,
	shownSize,
	sliderOf,
	stepImage,
	toggleZoom,
	wrapTab,
	zoomAt,
	zoomBounds,
	zoomKey,
	zoomStep,
} from "./image-lightbox-state";

test("stepping stops at the first and the last image instead of wrapping", () => {
	expect(stepImage(0, -1, 3)).toBe(0);
	expect(stepImage(0, 1, 3)).toBe(1);
	expect(stepImage(2, 1, 3)).toBe(2);
	expect(stepImage(5, 0, 3)).toBe(2);
	expect(stepImage(0, 1, 0)).toBe(0);
});

test("only the left and right arrows step", () => {
	expect(arrowStep("ArrowLeft")).toBe(-1);
	expect(arrowStep("ArrowRight")).toBe(1);
	expect(arrowStep("ArrowUp")).toBeUndefined();
	expect(arrowStep("Enter")).toBeUndefined();
});

test("focus wraps at both ends of the lightbox's controls and is otherwise left to the browser", () => {
	expect(wrapTab(2, 3, false)).toBe(0);
	expect(wrapTab(0, 3, true)).toBe(2);
	expect(wrapTab(1, 3, false)).toBeUndefined();
	expect(wrapTab(1, 3, true)).toBeUndefined();
	// Focus that is not on a control (the dialog itself) enters at the nearer end.
	expect(wrapTab(-1, 3, false)).toBe(0);
	expect(wrapTab(-1, 3, true)).toBe(2);
	expect(wrapTab(0, 0, false)).toBeUndefined();
});

test("a picture is fitted inside the stage, turned a quarter swaps its sides, and a small one is never enlarged", () => {
	let wide = { width: 2000, height: 1000 };
	let stage = { width: 1000, height: 800 };
	expect(fitScale(wide, stage, 0)).toBe(0.5);
	// Turned, it is 1000 wide and 2000 tall, so its height decides.
	expect(fitScale(wide, stage, 1)).toBe(0.4);
	expect(fitScale(wide, stage, 2)).toBe(0.5);
	expect(fitScale({ width: 100, height: 50 }, stage, 0)).toBe(1);
	expect(shownSize(wide, 0.4, 1)).toEqual({ width: 400, height: 800 });
});

test("the slider runs from fitted to its most on a logarithmic scale, and −/+ move it an eighth", () => {
	let bounds = zoomBounds(0.25);
	expect(bounds).toEqual({ min: 0.25, max: 2 });
	expect(zoomBounds(1)).toEqual({ min: 1, max: 8 });
	expect(sliderOf(0.25, bounds)).toBe(0);
	expect(sliderOf(2, bounds)).toBe(100);
	// The picture's own pixels sit two thirds along: 0.25 → 1 is two doublings of three.
	expect(sliderOf(1, bounds)).toBe(67);
	expect(scaleOf(50, bounds)).toBeCloseTo(Math.SQRT2 * 0.5, 5);
	expect(zoomStep(0.25, -1, bounds)).toBe(0.25);
	expect(sliderOf(zoomStep(0.25, 1, bounds), bounds)).toBe(13);
	// Steps add up exactly, however the slider rounds what it shows.
	expect(sliderOf(zoomStep(zoomStep(0.25, 1, bounds), 1, bounds), bounds)).toBe(25);
	expect(zoomStep(2, 1, bounds)).toBe(2);
});

test("a double-click goes to the picture's own pixels from fitted, and back to fitted from any zoom", () => {
	let large = zoomBounds(0.25);
	expect(toggleZoom(0.25, large)).toBe(1);
	expect(toggleZoom(1, large)).toBe(0.25);
	expect(toggleZoom(0.6, large)).toBe(0.25);
	// A picture already at its own size doubles instead.
	expect(toggleZoom(1, zoomBounds(1))).toBe(2);
});

test("the keys zoom: + and = in, - out, 0 back to fitted", () => {
	expect(zoomKey("+")).toBe(1);
	expect(zoomKey("=")).toBe(1);
	expect(zoomKey("-")).toBe(-1);
	expect(zoomKey("0")).toBe("fit");
	expect(zoomKey("a")).toBeUndefined();
});

test("a zoomed picture pans only as far as its edges, and a fitted one not at all", () => {
	let stage = { width: 1000, height: 800 };
	expect(clampPan({ x: 900, y: -900 }, { width: 2000, height: 1000 }, stage)).toEqual({
		x: 500,
		y: -100,
	});
	expect(clampPan({ x: 40, y: 40 }, { width: 500, height: 400 }, stage)).toEqual({ x: 0, y: 0 });
});

test("zooming about a point keeps that point of the picture under it", () => {
	// Doubling about a point 100px right of centre moves the picture 100px left.
	expect(zoomAt({ x: 0, y: 0 }, { x: 100, y: 0 }, 1, 2)).toEqual({ x: -100, y: 0 });
	expect(zoomAt({ x: 50, y: 20 }, { x: 0, y: 0 }, 2, 1)).toEqual({ x: 25, y: 10 });
});

test("a pinch asks for the ratio of the fingers' spread, about the point between them", () => {
	let moved = pinch([{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: -50, y: 0 }, { x: 150, y: 0 }]);
	expect(moved).toEqual({ ratio: 2, centre: { x: 50, y: 0 } });
});

test("when is said as Slack says it: minutes, hours and days ago, then the date", () => {
	let now = Date.UTC(2026, 10, 12, 15, 0, 0);
	expect(relativeTime(now - 10_000, now)).toBe("just now");
	expect(relativeTime(now - 5 * 60_000, now)).toBe("5 minutes ago");
	expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 hours ago");
	expect(relativeTime(now - 26 * 3_600_000, now)).toBe("yesterday");
	expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3 days ago");
	expect(relativeTime(Date.UTC(2026, 9, 1, 12), now)).toBe("Oct 1, 2026");
});

test("the line under the name says when, where and which file, leaving out what is not known", () => {
	expect(detailLine({ file: "chart.png", place: "Weekly plan", time: "3 hours ago" })).toBe(
		"3 hours ago in Weekly plan – chart.png",
	);
	expect(detailLine({ file: "chart.png", place: "a thread in Weekly plan", time: "just now" }))
		.toBe("just now in a thread in Weekly plan – chart.png");
	expect(detailLine({ file: "chart.png", place: "Weekly plan" })).toBe(
		"In Weekly plan – chart.png",
	);
	expect(detailLine({ file: "chart.png", time: "3 hours ago" })).toBe("3 hours ago – chart.png");
	expect(detailLine({ file: "chart.png" })).toBe("chart.png");
});

test("a file's name is the last part of its address's path, and a data address has none", () => {
	expect(fileNameOf("/api/images/abc.png?document=1")).toBe("abc.png");
	expect(fileNameOf("https://example.test/a/Weekly%20chart.webp#top")).toBe("Weekly chart.webp");
	expect(fileNameOf("data:image/png;base64,AAAA")).toBeUndefined();
	expect(fileNameOf("blob:https://example.test/1234")).toBeUndefined();
	expect(fileNameOf("https://example.test/")).toBeUndefined();
});

test("a download keeps its name, takes the extension its type says where it has none, and loses path characters", () => {
	expect(downloadName("chart.png", "image/png")).toBe("chart.png");
	expect(downloadName("Weekly chart", "image/jpeg")).toBe("Weekly chart.jpg");
	expect(downloadName("notes", "text/plain; charset=utf-8")).toBe("notes.txt");
	expect(downloadName("a/b:c", undefined)).toBe("a-b-c");
	expect(downloadName("", "image/webp")).toBe("image.webp");
});
