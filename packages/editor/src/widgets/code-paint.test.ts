import { expect, test } from "bun:test";

import { spans } from "./code-paint";

test("a token's run is its offset in the block's text, across lines", () => {
	expect(spans([
		[{ text: "let", role: "keyword" }, { text: " a " }, { text: "=", role: "keyword" }],
		[{ text: "  " }, { text: '"b"', role: "string" }],
	])).toEqual([
		{ role: "keyword", start: 0, end: 3 },
		{ role: "keyword", start: 6, end: 7 },
		{ role: "string", start: 10, end: 13 },
	]);
});

test("whitespace and unroled text are left unpainted", () => {
	expect(spans([[{ text: "\t", role: "keyword" }, { text: "plain" }], []])).toEqual([]);
});
