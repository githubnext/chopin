import { describe, expect, it } from "bun:test";

import { destination, gripBox, rowDestination, seamAt, seamBox, seams } from "./geometry";

import type { Track } from "./geometry";

/** Four tracks of unequal width, as measured cells actually are. */
const TRACKS: Track[] = [
	{ start: 0, end: 40 },
	{ start: 40, end: 140 },
	{ start: 140, end: 180 },
	{ start: 180, end: 380 },
];

describe("seams", () => {
	it("gives one more line than there are tracks", () => {
		expect(seams(TRACKS)).toEqual([0, 40, 140, 180, 380]);
	});

	it("has nothing to offer for a table with no tracks", () => {
		expect(seams([])).toEqual([]);
	});
});

describe("finding the seam a pointer means", () => {
	it("takes the nearest line rather than the track under the pointer", () => {
		expect(seamAt(TRACKS, 45)).toBe(1);
		expect(seamAt(TRACKS, 135)).toBe(2);
	});

	it("answers for a pointer past either end, so an overshoot still lands", () => {
		expect(seamAt(TRACKS, -500)).toBe(0);
		expect(seamAt(TRACKS, 9000)).toBe(4);
	});
});

describe("turning a seam into a destination index", () => {
	/*
	 * The library evaluates the destination after lifting the moved track out,
	 * so every seam past the origin means an index one lower. Getting this
	 * wrong lands the track one place from where it was dropped and nothing
	 * anywhere reports it.
	 */
	it("shifts down for a seam after the track's own position", () => {
		expect(destination(0, 3, 4)).toBe(2);
		expect(destination(0, 4, 4)).toBe(3);
	});

	it("does not shift for a seam before it", () => {
		expect(destination(3, 0, 4)).toBe(0);
		expect(destination(3, 2, 4)).toBe(2);
	});

	it("refuses both seams bounding where the track already is", () => {
		expect(destination(2, 2, 4)).toBeUndefined();
		expect(destination(2, 3, 4)).toBeUndefined();
	});

	it("refuses a seam off the end of the table", () => {
		expect(destination(0, 5, 4)).toBeUndefined();
		expect(destination(0, -1, 4)).toBeUndefined();
	});

	it("moves a track to the very front", () => {
		expect(destination(2, 0, 4)).toBe(0);
	});
});

describe("dropping a row", () => {
	it("clamps a drag above the header to the seam below it", () => {
		// The pointer ran off the top of a short table; that is still a request
		// for "as high as it goes", not a failed drag.
		expect(rowDestination(3, 0, 4)).toBe(1);
	});

	it("still refuses a drop that would not move the row", () => {
		expect(rowDestination(1, 0, 4)).toBeUndefined();
		expect(rowDestination(1, 1, 4)).toBeUndefined();
		expect(rowDestination(1, 2, 4)).toBeUndefined();
	});

	it("otherwise behaves as any other track", () => {
		expect(rowDestination(1, 4, 4)).toBe(3);
	});
});

describe("laying a rail out", () => {
	it("gives a column grip the width of its column and the depth of the rail", () => {
		// The rail starts where the table does, so a track measured at x=140
		// in the page sits 140 along a rail whose origin is 0.
		expect(gripBox("column", { start: 140, end: 180 }, 0, 16))
			.toEqual({ left: 140, top: 0, width: 40, height: 16 });
	});

	it("turns the same track through a right angle for a row", () => {
		expect(gripBox("row", { start: 140, end: 180 }, 0, 16))
			.toEqual({ left: 0, top: 140, width: 16, height: 40 });
	});

	it("subtracts the rail's own origin, so a scrolled table still lines up", () => {
		expect(gripBox("column", { start: 340, end: 380 }, 300, 16))
			.toEqual({ left: 40, top: 0, width: 40, height: 16 });
	});

	it("straddles a seam rather than starting at it", () => {
		// A seam is a line with no width; what is aimed at has to cover both
		// sides of it or it can only be hit from one.
		expect(seamBox("column", 140, 0, 16, 12))
			.toEqual({ left: 134, top: 0, width: 12, height: 16 });
		expect(seamBox("row", 140, 0, 16, 12))
			.toEqual({ left: 0, top: 134, width: 16, height: 12 });
	});
});
