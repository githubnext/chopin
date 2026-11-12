import { describe, expect, test } from "bun:test";

import { colour, colourable } from "./code-tokens";

import type { CodeLines, Tokenize } from "./code-tokens";

/** A tokenizer that colours each word, counts what it was asked to read, and carries a line count as its state. */
function counting() {
	let read: string[] = [];
	let tokenize = ((code: string, after?: unknown): CodeLines => {
		read.push(code);
		let lines = code.split("\n").map(line =>
			line ? line.split(/(?= )/).map(text => ({ text, role: "keyword" })) : []
		);
		return { lines, state: ((after as number | undefined) ?? 0) + lines.length as never };
	}) as Tokenize;
	return { read, tokenize };
}

let text = (lines: { text: string }[][]) =>
	lines.map(line => line.map(token => token.text).join(""))
		.join("\n");

describe("colourable", () => {
	test("a fence names a language to colour unless nobody named it or it is named as plain text", () => {
		expect(colourable("ts")).toBe(true);
		expect(colourable("lean")).toBe(true);
		expect(colourable("diff")).toBe(true);
		expect(colourable("")).toBe(false);
		expect(colourable("text")).toBe(false);
		expect(colourable("TXT")).toBe(false);
	});
});

describe("colour", () => {
	test("draws the code exactly, a trailing break included", () => {
		let { tokenize } = counting();
		for (let code of ["", "\n", "let a", "let a\nlet b", "let a\nlet b\n", "a\n\nb"]) {
			expect(text(colour(tokenize, code).lines)).toBe(code);
		}
	});

	test("a streamed block reads only the lines it gained, and its last line again on its own", () => {
		let { read, tokenize } = counting();
		let first = colour(tokenize, "let a = 1;\nlet b");
		expect(read).toEqual(["let a = 1;", "let b"]);
		read.length = 0;
		let second = colour(tokenize, "let a = 1;\nlet b = 2;\nlet c", first.held);
		expect(read).toEqual(["let b = 2;", "let c"]);
		expect(text(second.lines)).toBe("let a = 1;\nlet b = 2;\nlet c");
		// The grammar goes on from where the held lines left it.
		expect(second.held.state as unknown).toBe(2);
		read.length = 0;
		let third = colour(tokenize, "let a = 1;\nlet b = 2;\nlet c", second.held);
		expect(read).toEqual(["let c"]);
		expect(third.held).toBe(second.held);
	});

	test("a block that changed anywhere but its end, or another tokenizer, starts over", () => {
		let { read, tokenize } = counting();
		let held = colour(tokenize, "let a\nlet b\n").held;
		read.length = 0;
		colour(tokenize, "let x\nlet b\n", held);
		expect(read).toEqual(["let x\nlet b"]);
		let other = counting();
		colour(other.tokenize, "let a\nlet b\n", held);
		expect(other.read).toEqual(["let a\nlet b"]);
	});
});
