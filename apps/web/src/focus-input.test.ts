import { expect, test } from "bun:test";

import { focusInputForKey } from "./focus-input";

let plain = { altKey: false, ctrlKey: false, metaKey: false };

test("a plain key press is keyboard navigation", () => {
	expect(focusInputForKey(plain)).toBe("keyboard");
});

test("shortcut chords do not change the modality", () => {
	expect(focusInputForKey({ ...plain, metaKey: true })).toBeUndefined();
	expect(focusInputForKey({ ...plain, ctrlKey: true })).toBeUndefined();
	expect(focusInputForKey({ ...plain, altKey: true })).toBeUndefined();
});
