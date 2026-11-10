import { expect, test } from "bun:test";

import { arrowStep, stepImage, wrapTab } from "./image-lightbox-state";

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
