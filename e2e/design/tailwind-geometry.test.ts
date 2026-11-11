import { describe, expect, it } from "bun:test";

import { expected } from "./tailwind-geometry";

describe("what Tailwind's classes mean in pixels", () => {
	it("reads the model selector's trigger", () => {
		let trigger =
			"focus-visible:ring-ring/50 flex w-fit items-center justify-between gap-2 overflow-hidden rounded-md text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-1 disabled:cursor-not-allowed [&_svg]:pointer-events-none border-input hover:bg-accent border bg-transparent h-9 px-3 py-2";
		expect(expected(trigger)).toEqual({
			border: [1, 1, 1, 1],
			radius: 6,
			gap: 8,
			height: 36,
			padding: { 0: 8, 1: 12, 2: 8, 3: 12 },
			fontSize: 14,
			lineHeight: 20,
		});
	});

	it("lets a side beat its shorthand, in Tailwind's own order", () => {
		expect(expected("px-2 ps-3 pe-9 py-2").padding).toEqual({ 0: 8, 1: 36, 2: 8, 3: 12 });
		expect(expected("p-1 pb-0").padding).toEqual({ 0: 4, 1: 4, 2: 0, 3: 4 });
	});

	it("reads an important class, a size and a pill", () => {
		let got = expected("h-8! rounded-lg! size-6 rounded-full text-[13px] border-t");
		expect(got.height).toBe(24);
		expect(got.width).toBe(24);
		expect(got.radius).toBe(Infinity);
		expect(got.fontSize).toBe(13);
		expect(got.border).toEqual([1, 0, 0, 0]);
	});

	it("does not read variants, colours or arbitrary values as sizes", () => {
		let got = expected(
			"hover:px-9 md:rounded-2xl text-muted-foreground border-input [&_svg]:size-9 rounded-[min(var(--radius-md),10px)]",
		);
		expect(got).toEqual({ border: [0, 0, 0, 0], radius: 0 });
	});

	it("takes a line height from the type step unless the element sets its own leading", () => {
		expect(expected("text-xs").lineHeight).toBe(16);
		expect(expected("text-xs leading-none").lineHeight).toBeUndefined();
	});
});
