import { expect, test } from "bun:test";

import { edgeMask, scrollEdges } from "./tab-edges";

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
