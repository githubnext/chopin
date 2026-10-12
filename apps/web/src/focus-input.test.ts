import { expect, test } from "bun:test";

import { focusInputForKey, focusOriginFor } from "./focus-input";

test("a plain key press is keyboard navigation", () => {
	expect(focusInputForKey({ key: "Tab" })).toBe("keyboard");
});

test("a chord is keyboard navigation", () => {
	expect(focusInputForKey({ key: "ArrowDown" })).toBe("keyboard");
});

test("a bare modifier does not change the modality", () => {
	for (let key of ["Control", "Meta", "Alt", "Shift", "CapsLock", "Fn"]) {
		expect(focusInputForKey({ key })).toBeUndefined();
	}
});

test("focus arriving at a new element takes the latest input", () => {
	let state = { target: "title", origin: "pointer" as const };
	expect(focusOriginFor(state, "composer", "keyboard")).toBe("keyboard");
});

test("focus returning to the same element keeps its origin", () => {
	let state = { target: "composer", origin: "pointer" as const };
	expect(focusOriginFor(state, "composer", "keyboard")).toBe("pointer");
});

test("focus before any input keeps the previous origin", () => {
	expect(focusOriginFor({ target: undefined, origin: undefined }, "composer", undefined))
		.toBeUndefined();
});
