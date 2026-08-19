import { expect, test } from "bun:test";

import { commentRevealScroll } from "./comment-reveal";

test("comment reveal places short passages above the sheet and tall passages at the viewport top", () => {
	expect(commentRevealScroll({
		currentScroll: 400,
		gap: 20,
		maxScroll: 1_000,
		passageBottom: 700,
		passageTop: 650,
		sheetTop: 500,
		viewportTop: 80,
	})).toBe(620);
	expect(commentRevealScroll({
		currentScroll: 400,
		gap: 20,
		maxScroll: 1_000,
		passageBottom: 240,
		passageTop: 200,
		sheetTop: 500,
		viewportTop: 80,
	})).toBe(160);
	expect(commentRevealScroll({
		currentScroll: 400,
		gap: 20,
		maxScroll: 1_000,
		passageBottom: 800,
		passageTop: 200,
		sheetTop: 500,
		viewportTop: 80,
	})).toBe(500);
});

test("comment reveal stays within the document scroll range", () => {
	expect(commentRevealScroll({
		currentScroll: 40,
		gap: 20,
		maxScroll: 1_000,
		passageBottom: 100,
		passageTop: 80,
		sheetTop: 500,
		viewportTop: 80,
	})).toBe(0);
	expect(commentRevealScroll({
		currentScroll: 900,
		gap: 20,
		maxScroll: 1_000,
		passageBottom: 800,
		passageTop: 760,
		sheetTop: 500,
		viewportTop: 80,
	})).toBe(1_000);
});
