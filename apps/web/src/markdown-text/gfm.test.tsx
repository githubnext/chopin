import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { allMessageGfmParts, messageGfmRemarkPlugin } from "./gfm";
import { MarkdownText } from "./markdown-text";

function draw(text: string, plugin: unknown): string {
	return renderToStaticMarkup(
		createElement(MarkdownText, {
			allowedElements: [
				"a",
				"code",
				"del",
				"em",
				"input",
				"li",
				"ol",
				"p",
				"pre",
				"strong",
				"table",
				"tbody",
				"td",
				"th",
				"thead",
				"tr",
				"ul",
			],
			remarkPlugins: plugin ? [plugin as never] : [],
			text,
			unwrapDisallowed: true,
		}),
	);
}

const SOURCES = [
	"plain text with `code`, a [link](https://example.com) and **weight**",
	"| A | B |\n| - | - |\n| 1 | 2 |",
	"A | B\n- | -\n1 | 2",
	"| one column |\n| - |\n| row |",
	"~~gone~~ and ~one~ and ~~two~~",
	"- [x] done\n- [ ] open\n- plain",
	"1. [X] numbered task",
	"| A | B |\n| - | - |\n| ~~1~~ | [x] |\n\n~~after~~\n\n- [ ] task",
	// Marks that are text: inside code, in a sentence, or not a table.
	"```\n| a | b |\n| - | - |\n~~x~~ [x]\n```",
	"Use `a | b` or the shell's `cmd1 | cmd2`, not a table",
	"The array [x] is indexed, and [ ] is empty",
	"a | b without a delimiter row",
	"- item with | pipe\n- another",
	"Footnote[^1] and https://example.com and a@b.co\n\n[^1]: The note.",
	"",
	// Single-column tables, with and without pipes, and every alignment mark.
	"a\n:-",
	"a\n-:",
	"a\n:-:",
	":-\n:-",
	"|a\n|-",
	"a|\n-|",
	"a\n|-",
	"|a|\n|:-:|\n|b|",
	"a | b\n:- | -:\nc | d",
	// Whitespace, tabs, carriage returns and indentation around the same syntax.
	"  | A | B |\n  | - | - |\n  | 1 | 2 |  ",
	"\t| A |\n\t| - |",
	"    | A | B |\n    | - | - |",
	"| A | B |\r\n| - | - |\r\n| 1 | 2 |",
	"| A | B |\r| - | - |\r| 1 | 2 |",
	"\n\n| A | B |\n| - | - |\n\n",
	"> | A | B |\n> | - | - |\n> | 1 | 2 |",
	"> a\n> :-",
	"- | A | B |\n  | - | - |\n  | 1 | 2 |",
	"1. a | b\n   - | -",
	"|   |\n|---|",
	"| A |\n|-:|\n| ~~b~~ |",
	// Escaped delimiters are still the marks, or text, exactly as the parser reads them.
	"\\| A | B |\n| - | - |",
	"| A \\| B |\n| - | - |",
	"\\~~not struck\\~~ and ~~struck~~",
	"~~~three tildes~~~ and ~~ two ~~",
	"\\[x] is not a box, [x] alone, and - [x] is one",
	"- \\[x] escaped\n- [x] real",
	// Task boxes in every case and space, and ones that are not at the start of an item.
	"- [X] upper\n- [x] lower\n- [ ] space\n- [\t] tab",
	"- [\n]",
	"-   [ ]   spaced",
	"- text [x] later",
	"- [xx] two",
	"* [x] star\n+ [x] plus",
	"[x] outside a list",
	// A table inside code, a quote, a list and a task list at once.
	"- [x] | A |\n  | - |",
];

/** Every prefix of a source, as a stream delivers it. */
const STREAMED = [
	"Intro\n\n| Queue | Owner |\n| :-- | --: |\n| shared | platform |\n\n- [x] done\n- [ ] open\n\n~~gone~~ text\n",
	"a\n:-:\nb\n\n> | q |\n> | - |\n",
];

/** A small deterministic generator, so a failure names the same source every run. */
function sources(count: number): string[] {
	let tokens = [
		"|",
		"-",
		":",
		"~",
		"~~",
		"[",
		"]",
		"[x]",
		"[ ]",
		" ",
		"  ",
		"\t",
		"x",
		"X",
		"a",
		"b",
		"1.",
		"- ",
		"* ",
		"> ",
		"\\",
		"`",
		"*",
		"#",
		"\n",
		"\n",
		"\r\n",
		"---",
		"-|-",
		"|-|",
		":-:",
	];
	let seed = 12345;
	let next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	let made: string[] = [];
	for (let index = 0; index < count; index++) {
		let length = 1 + Math.floor(next() * 14);
		let text = "";
		for (let token = 0; token < length; token++) text += tokens[Math.floor(next() * tokens.length)];
		made.push(text);
	}
	return made;
}

test("a message takes the parts of GitHub's Markdown its text can use, and nothing else", () => {
	expect(messageGfmRemarkPlugin("plain text, a `code` span and a [link](https://example.com)"))
		.toBeUndefined();
	expect(messageGfmRemarkPlugin("")).toBeUndefined();
	expect(messageGfmRemarkPlugin("| a |\n| - |")).toBeDefined();
	expect(messageGfmRemarkPlugin("| a |")).toBeUndefined();
	expect(messageGfmRemarkPlugin("~~a~~")).toBeDefined();
	expect(messageGfmRemarkPlugin("~a~")).toBeUndefined();
	expect(messageGfmRemarkPlugin("- [x] a")).toBeDefined();
	// The same marks give the same plugin, so a message's options keep their identity.
	expect(messageGfmRemarkPlugin("| a |\n| - |")).toBe(messageGfmRemarkPlugin("x | y\n- | -"));
	expect(messageGfmRemarkPlugin("| a |\n| - |")).not.toBe(messageGfmRemarkPlugin("~~a~~"));
});

function expectSame(source: string) {
	expect(draw(source, messageGfmRemarkPlugin(source)), JSON.stringify(source)).toBe(
		draw(source, allMessageGfmParts),
	);
}

test("choosing the parts by source never changes the tree that reading all three would give", () => {
	for (let source of SOURCES) expectSame(source);
});

test("nor does it for any prefix of a streamed message", () => {
	for (let text of STREAMED) {
		for (let end = 0; end <= text.length; end++) expectSame(text.slice(0, end));
	}
});

test("nor does it for four thousand generated sources of the marks that matter", () => {
	for (let source of sources(4000)) expectSame(source);
});

test("a column with no pipe is a table the choice keeps, and a row of hyphens alone is not", () => {
	for (let source of ["a\n:-", "a\n-:", ":-\n:-"]) {
		expect(messageGfmRemarkPlugin(source), JSON.stringify(source)).toBeDefined();
		expect(draw(source, messageGfmRemarkPlugin(source))).toContain("<table");
	}
	// Hyphens alone make a rule or a heading, never a table, and need no extension.
	expect(messageGfmRemarkPlugin("a\n---")).toBeUndefined();
	expect(messageGfmRemarkPlugin("Note: a | b, 3 - 1 and :- are text")).toBeUndefined();
});

test("what it reads is tables, strikethrough and task lists, and no footnote or bare address", () => {
	let tables = draw(SOURCES[1]!, messageGfmRemarkPlugin(SOURCES[1]!));
	expect(tables).toContain("<table");
	expect(draw(SOURCES[4]!, messageGfmRemarkPlugin(SOURCES[4]!))).toContain("<del>gone</del>");
	expect(draw(SOURCES[5]!, messageGfmRemarkPlugin(SOURCES[5]!))).toContain('type="checkbox"');
	let footnote = draw(SOURCES[13]!, messageGfmRemarkPlugin(SOURCES[13]!));
	expect(footnote).not.toContain("<a");
	expect(footnote).toContain("Footnote[^1] and https://example.com and a@b.co");
});
