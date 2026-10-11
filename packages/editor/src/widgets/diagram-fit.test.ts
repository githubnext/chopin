import { expect, test } from "bun:test";

import { fitsLegibly } from "./diagram-fit";

test("a drawing fits while it keeps three quarters of its size", () => {
	expect(fitsLegibly(300, 300)).toBe(true);
	expect(fitsLegibly(300, 400)).toBe(true);
	expect(fitsLegibly(300, 401)).toBe(false);
	expect(fitsLegibly(358, 1641)).toBe(false);
});

test("a drawing with no measured width is treated as fitting", () => {
	expect(fitsLegibly(300, 0)).toBe(true);
	expect(fitsLegibly(300, Number.NaN)).toBe(true);
});
