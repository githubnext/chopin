import { describe, expect, test } from "bun:test";

import { applyFormat } from "./format-markdown";

import type { Format } from "./format-markdown";

/** The text after a mark, with `[` and `]` where the selection is, so each case reads as it looks. */
function shown(kind: Format, text: string, start: number, end = start): string {
	let result = applyFormat(kind, text, { start, end });
	return `${result.text.slice(0, result.start)}[${result.text.slice(result.start, result.end)}]${
		result.text.slice(result.end)
	}`;
}

describe("a mark wraps what is selected, and what is selected stays selected inside it", () => {
	test("bold, italic, strikethrough and code", () => {
		expect(shown("bold", "make it clear", 8, 13)).toBe("make it **[clear]**");
		expect(shown("italic", "make it clear", 8, 13)).toBe("make it _[clear]_");
		expect(shown("strike", "make it clear", 8, 13)).toBe("make it ~~[clear]~~");
		expect(shown("code", "run bun test", 4, 12)).toBe("run `[bun test]`");
	});

	test("with nothing selected it opens a pair and leaves the caret between", () => {
		expect(shown("bold", "hello ", 6)).toBe("hello **[]**");
		expect(shown("code", "", 0)).toBe("`[]`");
	});

	test("a second press takes the mark off again", () => {
		let once = applyFormat("bold", "make it clear", { start: 8, end: 13 });
		let twice = applyFormat("bold", once.text, { start: once.start, end: once.end });
		expect(twice.text).toBe("make it clear");
		expect([twice.start, twice.end]).toEqual([8, 13]);
	});

	test("leaves other marks alone: an italic word wrapped in bold keeps its underscores", () => {
		expect(shown("bold", "a _b_ c", 2, 5)).toBe("a **[_b_]** c");
	});
});

describe("a link", () => {
	test("wraps the selection and selects the address to type", () => {
		expect(shown("link", "see the plan", 8, 12)).toBe("see the [plan]([url])");
	});

	test("with nothing selected offers its text and address", () => {
		expect(shown("link", "", 0)).toBe("[[text]](url)");
	});
});

describe("a list prefixes each line the selection touches", () => {
	test("numbers them in order", () => {
		expect(applyFormat("numbered", "one\ntwo\nthree", { start: 0, end: 13 }).text).toBe(
			"1. one\n2. two\n3. three",
		);
	});

	test("marks them with dashes, and only the lines touched", () => {
		let result = applyFormat("bulleted", "a\nb\nc", { start: 2, end: 3 });
		expect(result.text).toBe("a\n- b\nc");
	});

	test("with the caret in a line it marks that line", () => {
		expect(applyFormat("bulleted", "first\nsecond", { start: 8, end: 8 }).text).toBe(
			"first\n- second",
		);
	});

	test("takes the marks off lines that all have them", () => {
		let on = applyFormat("numbered", "a\nb", { start: 0, end: 3 });
		expect(applyFormat("numbered", on.text, { start: on.start, end: on.end }).text).toBe("a\nb");
	});
});

describe("a code block", () => {
	test("fences the selection on lines of their own", () => {
		expect(applyFormat("block", "x = 1", { start: 0, end: 5 }).text).toBe("```\nx = 1\n```");
	});

	test("starts on a new line after text, and leaves the caret on the empty line inside", () => {
		let result = applyFormat("block", "run it:", { start: 7, end: 7 });
		expect(result.text).toBe("run it:\n```\n\n```");
		expect(result.start).toBe("run it:\n```\n".length);
		expect(result.end).toBe(result.start);
	});
});

describe("the edit it reports is what changed, so references outside it can be kept", () => {
	test("the range of the original that the new text replaces", () => {
		let text = "keep #ref and make it clear";
		let result = applyFormat("bold", text, { start: 22, end: 27 });
		expect(text.slice(0, result.edit.start)).toBe("keep #ref and make it ");
		expect(text.slice(result.edit.end)).toBe("");
	});
});
