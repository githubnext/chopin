import { describe, expect, it } from "bun:test";

import {
	COMMENT_SHEET_SNAP_POINTS,
	commentSheetFitSnapPoint,
	commentSheetTop,
	nextCommentSheetSnapPoint,
	usesCommentSheet,
} from "./comment-sheet";

describe("comment sheet snap points", () => {
	it("cycles between the medium and large detents", () => {
		expect(COMMENT_SHEET_SNAP_POINTS).toEqual([0.85, 0.92]);
		expect(nextCommentSheetSnapPoint(0.4, 0.4)).toBe(0.92);
		expect(nextCommentSheetSnapPoint(0.92, 0.4)).toBe(0.4);
	});

	it("sizes the medium detent to the content within bounds", () => {
		expect(commentSheetFitSnapPoint(422, 844)).toBeCloseTo(0.5);
		expect(commentSheetFitSnapPoint(20, 844)).toBe(0.2);
		expect(commentSheetFitSnapPoint(2000, 844)).toBe(0.85);
		expect(commentSheetFitSnapPoint(0, 844)).toBe(0.85);
		expect(commentSheetFitSnapPoint(300, 0)).toBe(0.85);
	});

	it("places the medium detent within the visual viewport", () => {
		expect(commentSheetTop(844)).toBeCloseTo(126.6);
		expect(commentSheetTop(844, 0.55)).toBeCloseTo(379.8);
	});

	it("reserves the drawer for phone-sized coarse pointers", () => {
		expect(usesCommentSheet({ coarse: true, width: 390 })).toBe(true);
		expect(usesCommentSheet({ coarse: true, width: 430 })).toBe(true);
		expect(usesCommentSheet({ coarse: true, width: 431 })).toBe(false);
		expect(usesCommentSheet({ coarse: true, width: 768 })).toBe(false);
		expect(usesCommentSheet({ coarse: false, width: 390 })).toBe(false);
	});
});
