import { describe, expect, it } from "bun:test";

import {
	COMMENT_SHEET_LARGE,
	commentSheetHeading,
	commentSheetHeight,
	commentSheetTop,
	usesCommentSheet,
} from "./comment-sheet";

describe("comment sheet size", () => {
	it("stands as tall as its content", () => {
		expect(commentSheetHeight(320, 844)).toBe(320);
	});

	it("stops at the large detent, so the notes scroll and the composer stays pinned", () => {
		expect(COMMENT_SHEET_LARGE).toBe(0.92);
		expect(commentSheetHeight(2_000, 844)).toBeCloseTo(776.48);
	});

	it("shrinks to the space the keyboard leaves", () => {
		expect(commentSheetHeight(600, 500)).toBeCloseTo(460);
		expect(commentSheetHeight(200, 500)).toBe(200);
	});

	it("takes the detent before content is measured and nothing without a viewport", () => {
		expect(commentSheetHeight(0, 844)).toBeCloseTo(776.48);
		expect(commentSheetHeight(300, 0)).toBe(0);
	});

	it("places its top edge on the visual viewport's bottom", () => {
		expect(commentSheetTop({ top: 0, height: 844 }, 300)).toBe(544);
		expect(commentSheetTop({ top: 0, height: 506 }, 300)).toBe(206);
		expect(commentSheetTop({ top: 0, height: 844 }, 2_000)).toBeCloseTo(67.52);
	});

	it("reserves the drawer for phone-sized coarse pointers", () => {
		expect(usesCommentSheet({ coarse: true, width: 390 })).toBe(true);
		expect(usesCommentSheet({ coarse: true, width: 430 })).toBe(true);
		expect(usesCommentSheet({ coarse: true, width: 431 })).toBe(false);
		expect(usesCommentSheet({ coarse: true, width: 768 })).toBe(false);
		expect(usesCommentSheet({ coarse: false, width: 390 })).toBe(false);
	});
});

describe("comment sheet heading", () => {
	it("quotes a lone thread's passage instead of titling it", () => {
		expect(commentSheetHeading({ kind: "thread", quote: "replay it", siblings: 1 })).toEqual({
			kind: "quote",
			quote: "replay it",
		});
	});

	it("leads a thread opened from its block's list back to the list", () => {
		expect(commentSheetHeading({ kind: "thread", quote: "replay it", siblings: 3 })).toEqual({
			kind: "back",
			count: 3,
		});
	});

	it("counts a list's threads once", () => {
		expect(commentSheetHeading({ kind: "list", count: 2 })).toEqual({ kind: "count", count: 2 });
	});

	it("quotes a draft's passage", () => {
		expect(commentSheetHeading({ kind: "draft", quote: "the epoch" })).toEqual({
			kind: "quote",
			quote: "the epoch",
		});
	});

	it("falls back to a title when there is no passage to quote", () => {
		expect(commentSheetHeading({ kind: "draft", quote: " " })).toEqual({
			kind: "title",
			title: "New comment",
		});
		expect(commentSheetHeading({ kind: "thread", quote: "", siblings: 1 })).toEqual({
			kind: "title",
			title: "Comment",
		});
		expect(commentSheetHeading({ kind: "other", title: "Resolved" })).toEqual({
			kind: "title",
			title: "Resolved",
		});
	});
});
