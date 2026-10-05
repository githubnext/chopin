import { describe, expect, test } from "bun:test";

import { inlineSegments, plainInlineList, plainInlineText } from "./inline-segments";

let prose = (text: string) => ({ code: false, text });
let code = (text: string) => ({ code: true, text });

describe("inlineSegments", () => {
	test("splits a code span from prose", () => {
		expect(inlineSegments("the single `.bak` behavior")).toEqual([
			prose("the single "),
			code(".bak"),
			prose(" behavior"),
		]);
	});

	test("handles several spans at the edges", () => {
		expect(inlineSegments("`a` and `b`")).toEqual([code("a"), prose(" and "), code("b")]);
	});

	test("adjacent spans stay separate", () => {
		expect(inlineSegments("`a``b`")).toEqual([code("a``b")]);
		expect(inlineSegments("`a` `b`")).toEqual([code("a"), prose(" "), code("b")]);
	});

	test("an unmatched backtick stays literal", () => {
		expect(inlineSegments("it`s fine")).toEqual([prose("it`s fine")]);
		expect(inlineSegments("a `b` c`d")).toEqual([prose("a "), code("b"), prose(" c`d")]);
	});

	test("an empty pair stays literal", () => {
		expect(inlineSegments("a `` b")).toEqual([prose("a `` b")]);
	});

	test("a longer run closes only at a run of the same length", () => {
		expect(inlineSegments("``a`b``")).toEqual([code("a`b")]);
		expect(inlineSegments("```x```")).toEqual([code("x")]);
		expect(inlineSegments("``a` b")).toEqual([prose("``a` b")]);
		expect(inlineSegments("`a``b")).toEqual([prose("`a``b")]);
	});

	test("strips one space from each side only when both are present", () => {
		expect(inlineSegments("` a `")).toEqual([code("a")]);
		expect(inlineSegments("`  a  `")).toEqual([code(" a ")]);
		expect(inlineSegments("` a`")).toEqual([code(" a")]);
		expect(inlineSegments("`` `a` ``")).toEqual([code("`a`")]);
	});

	test("whitespace-only content stays literal", () => {
		expect(inlineSegments("a `  ` b")).toEqual([prose("a `  ` b")]);
	});

	test("an escaped backtick outside a span is a literal backtick", () => {
		expect(inlineSegments("\\`x\\`")).toEqual([prose("`x`")]);
		expect(inlineSegments("a \\` `b`")).toEqual([prose("a ` "), code("b")]);
	});

	test("backslashes inside a span are literal", () => {
		expect(inlineSegments("`a\\`")).toEqual([code("a\\")]);
		expect(inlineSegments("`C:\\dir`")).toEqual([code("C:\\dir")]);
	});
});

describe("plain text for accessible names", () => {
	test("has no code delimiters", () => {
		expect(plainInlineText("use `x` here")).toBe("use x here");
		expect(plainInlineText("``a`b``")).toBe("a`b");
		expect(plainInlineText("")).toBe("");
	});

	test("lists are read per item, never across the separator", () => {
		expect(plainInlineList(["a `b", "c` d"])).toBe("a `b, c` d");
		expect(plainInlineList(["`a`", "`b`"])).toBe("a, b");
	});

	test("label builders carry no backticks", () => {
		let label = `${plainInlineText("Keep `.bak` files")} — ${plainInlineList(["`a`", "``b``"])}`;
		expect(label).toBe("Keep .bak files — a, b");
		expect(label.includes("`")).toBe(false);
	});
});
