import { expect, test } from "bun:test";

import { edgeMask, revealDelta, scrollEdges } from "./tab-edges";

test("reports the sides that hide content", () => {
	expect(scrollEdges(0, 300, 300)).toEqual({ start: false, end: false });
	expect(scrollEdges(0, 300, 900)).toEqual({ start: false, end: true });
	expect(scrollEdges(200, 300, 900)).toEqual({ start: true, end: true });
	expect(scrollEdges(600, 300, 900)).toEqual({ start: true, end: false });
});

test("masks only when something overflows", () => {
	expect(edgeMask({ start: false, end: false })).toBeUndefined();
	expect(edgeMask({ start: false, end: true })).toContain("transparent)");
	expect(edgeMask({ start: true, end: false })).toContain("(to right, transparent,");
});

test("reveals an item clear of the fades", () => {
	let view = { left: 0, right: 300 };
	expect(revealDelta(view, { left: 50, right: 150 }, 32)).toBe(0);
	expect(revealDelta(view, { left: 10, right: 110 }, 32)).toBe(-22);
	expect(revealDelta(view, { left: 200, right: 290 }, 32)).toBe(22);
});
