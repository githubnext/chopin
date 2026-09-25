import { expect, test } from "bun:test";

import { scrub } from "./geometry";
import { parseScrubDraft } from "./scrub-field";

test("a typed value becomes the drag or arrow starting value", () => {
	let typed = parseScrubDraft("25%", 0, 100);
	expect(typed).toBe(25);
	expect(scrub(typed!, 8, { step: 1, min: 0, max: 100 })).toBe(27);
	expect(scrub(typed!, 4, { step: 1, min: 0, max: 100 })).toBe(26);
});

test("typed values clamp; empty, invalid and nonfinite drafts do not replace the current value", () => {
	expect(parseScrubDraft("-300°", -180, 180)).toBe(-180);
	expect(parseScrubDraft("900", 0, 100)).toBe(100);
	expect(parseScrubDraft("", 0, 100)).toBeNull();
	expect(parseScrubDraft("oops", 0, 100)).toBeNull();
	expect(parseScrubDraft("Infinity", 0, 100)).toBeNull();
});
