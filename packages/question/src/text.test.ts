import { expect, test } from "bun:test";

import { multiline, questionHeading, questionParts } from "./text";

test("a one-line question is a heading alone, exactly as before", () => {
	expect(questionParts("What auth system should we use?")).toEqual({
		heading: "What auth system should we use?",
	});
	expect(questionParts("  1. Use *nix paths, snake_case_names or 2 * 3?  ")).toEqual({
		heading: "1. Use *nix paths, snake_case_names or 2 * 3?",
	});
});

test("the first line is the heading and the rest is the body", () => {
	let text = "Confirm the earlier answers\n\n- Storage: PostgreSQL\n- Rollout: small pilot\n";
	expect(questionParts(text)).toEqual({
		heading: "Confirm the earlier answers",
		body: "- Storage: PostgreSQL\n- Rollout: small pilot",
	});
	expect(questionHeading(text)).toBe("Confirm the earlier answers");
});

test("Windows line breaks, leading blank lines and an empty remainder are tidied", () => {
	expect(questionParts("\n\r\nTitle\r\nBody line\r\n")).toEqual({
		heading: "Title",
		body: "Body line",
	});
	expect(questionParts("Title\n   \n")).toEqual({ heading: "Title" });
});

test("only text with a line break is several lines", () => {
	expect(multiline("One line with *stars* and _underscores_")).toBe(false);
	expect(multiline("One line\n")).toBe(false);
	expect(multiline("First\nSecond")).toBe(true);
});
