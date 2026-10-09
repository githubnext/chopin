import { describe, expect, test } from "bun:test";

import { diffSourceLine, lastLineStart, offsetOfLine } from "./source-offset";

const PATCH = [
	"--- a/room.ts",
	"+++ b/room.ts",
	"@@ -1,4 +1,4 @@",
	" open() {",
	"-\treturn 1;",
	"+\treturn 2;",
	" }",
	"@@ -9,2 +9,2 @@",
	" }",
].join("\n");

describe("offsetOfLine", () => {
	test("finds a column on a line and clamps it to that line", () => {
		expect(offsetOfLine("ab\ncdef\ng", 1, 2)).toBe(5);
		expect(offsetOfLine("ab\ncdef\ng", 1, 99)).toBe(7);
		expect(offsetOfLine("ab\ncdef\ng", 0)).toBe(0);
	});

	test("refuses a line the source does not have", () => {
		expect(offsetOfLine("ab", 1)).toBeUndefined();
		expect(offsetOfLine("ab", -1)).toBeUndefined();
	});
});

test("the last line starts after the last newline", () => {
	expect(lastLineStart("a\nbc\nd")).toBe(5);
	expect(lastLineStart("abc")).toBe(0);
});

describe("diffSourceLine", () => {
	test("finds a changed line by its kind and text", () => {
		expect(diffSourceLine(PATCH, "change-deletion", "\treturn 1;", 0)).toBe(4);
		expect(diffSourceLine(PATCH, "change-addition", "\treturn 2;", 0)).toBe(5);
	});

	test("tells equal context lines apart by their order", () => {
		expect(diffSourceLine(PATCH, "context", "}", 0)).toBe(6);
		expect(diffSourceLine(PATCH, "context", "}", 1)).toBe(8);
	});

	test("does not guess at a line it cannot find", () => {
		expect(diffSourceLine(PATCH, "change-addition", "\treturn 1;", 0)).toBeUndefined();
		expect(diffSourceLine(PATCH, "hunk", "@@", 0)).toBeUndefined();
	});
});
