import { describe, expect, test } from "bun:test";

import { keepsHeadingForBar, leavesTowardsBar } from "./toolbar-aim";

let bar = { left: 546, top: 54, right: 742, bottom: 90 };

describe("a pointer leaving its row for the toolbar over the row before", () => {
	test("heads for the bar when it leaves upwards, level with it, from the left, below or the right", () => {
		expect(leavesTowardsBar(bar, { x: 500, y: 92 }, { x: 506, y: 88 })).toBe(true);
		expect(leavesTowardsBar(bar, { x: 562, y: 92 }, { x: 562, y: 88 })).toBe(true);
		expect(leavesTowardsBar(bar, { x: 760, y: 92 }, { x: 754, y: 88 })).toBe(true);
	});

	test("does not when it leaves downwards, sideways or away from the bar", () => {
		expect(leavesTowardsBar(bar, { x: 562, y: 86 }, { x: 562, y: 90 })).toBe(false);
		expect(leavesTowardsBar(bar, { x: 500, y: 88 }, { x: 506, y: 88 })).toBe(false);
		expect(leavesTowardsBar(bar, { x: 500, y: 92 }, { x: 480, y: 88 })).toBe(false);
	});

	test("does not when it leaves above the bar's foot by more than a tremor", () => {
		expect(leavesTowardsBar(bar, { x: 562, y: 140 }, { x: 562, y: 40 })).toBe(false);
		expect(leavesTowardsBar(bar, { x: 562, y: 140 }, { x: 562, y: 100 })).toBe(false);
	});

	test("keeps heading while it stays level with the bar and comes no farther off across it", () => {
		expect(keepsHeadingForBar(bar, { x: 506, y: 88 }, { x: 515, y: 85 })).toBe(true);
		expect(keepsHeadingForBar(bar, { x: 515, y: 85 }, { x: 515, y: 80 })).toBe(true);
		expect(keepsHeadingForBar(bar, { x: 515, y: 85 }, { x: 514, y: 86 })).toBe(true);
		expect(keepsHeadingForBar(bar, { x: 600, y: 70 }, { x: 590, y: 66 })).toBe(true);
	});

	test("turns away once it moves off across the bar or out of its level", () => {
		expect(keepsHeadingForBar(bar, { x: 515, y: 85 }, { x: 500, y: 85 })).toBe(false);
		expect(keepsHeadingForBar(bar, { x: 515, y: 60 }, { x: 520, y: 50 })).toBe(false);
		expect(keepsHeadingForBar(bar, { x: 515, y: 88 }, { x: 520, y: 96 })).toBe(false);
	});
});
