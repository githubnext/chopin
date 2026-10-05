import { describe, expect, test } from "bun:test";

import { inlineSegments, plainInlineText } from "./inline-segments";

describe("inlineSegments", () => {
	test("splits a code span from prose", () => {
		expect(inlineSegments("the single `.bak` behavior")).toEqual([
			{ code: false, text: "the single " },
			{ code: true, text: ".bak" },
			{ code: false, text: " behavior" },
		]);
	});

	test("handles several spans and edges", () => {
		expect(inlineSegments("`a` and `b`")).toEqual([
			{ code: true, text: "a" },
			{ code: false, text: " and " },
			{ code: true, text: "b" },
		]);
	});

	test("leaves an unmatched backtick literal", () => {
		expect(inlineSegments("it`s fine")).toEqual([{ code: false, text: "it`s fine" }]);
		expect(inlineSegments("a `b` c`d")).toEqual([
			{ code: false, text: "a " },
			{ code: true, text: "b" },
			{ code: false, text: " c`d" },
		]);
	});

	test("leaves an empty pair literal", () => {
		expect(inlineSegments("a `` b")).toEqual([{ code: false, text: "a `` b" }]);
	});

	test("plain text has no delimiters", () => {
		expect(plainInlineText("use `x` here")).toBe("use x here");
		expect(plainInlineText("")).toBe("");
	});
});
