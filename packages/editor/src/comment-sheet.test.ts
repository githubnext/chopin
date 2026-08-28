import { describe, expect, it } from "bun:test";

import {
	COMMENT_SHEET_SNAP_POINTS,
	commentSheetTop,
	nextCommentSheetSnapPoint,
	usesCommentSheet,
} from "./comment-sheet";

describe("comment sheet snap points", () => {
	it("cycles between the medium and large detents", () => {
		expect(COMMENT_SHEET_SNAP_POINTS).toEqual([0.55, 0.92]);
		expect(nextCommentSheetSnapPoint(0.55)).toBe(0.92);
		expect(nextCommentSheetSnapPoint(0.92)).toBe(0.55);
	});

	it("places the medium detent within the visual viewport", () => {
		expect(commentSheetTop(844)).toBeCloseTo(379.8);
	});

	it("reserves the drawer for phone-sized coarse pointers", () => {
		expect(usesCommentSheet({ coarse: true, width: 390 })).toBe(true);
		expect(usesCommentSheet({ coarse: true, width: 430 })).toBe(true);
		expect(usesCommentSheet({ coarse: true, width: 431 })).toBe(false);
		expect(usesCommentSheet({ coarse: true, width: 768 })).toBe(false);
		expect(usesCommentSheet({ coarse: false, width: 390 })).toBe(false);
	});
});
