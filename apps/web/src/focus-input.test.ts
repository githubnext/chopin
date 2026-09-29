import { expect, test } from "bun:test";

import { focusInputForKey } from "./focus-input";

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
