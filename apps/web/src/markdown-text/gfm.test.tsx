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
	// A box whose bracket is split by a line ending, with the container's prefix on the next line.
	"- [\r\n] a",
	"- [\n  ] a",
	"1. [\r\n   ] a",
	"> - [\n>   ] a",
	"> - [\n> ] a",
	"- [\n] a",
	"- [\r] a",
	"> [\n> ] not in a list",
	"- [\n\t] a",
	"- [\n  x] a",
	"- [x\n  ] a",
	"* [x] star\n+ [x] plus",
	"[x] outside a list",
	// A table inside code, a quote, a list and a task list at once.
	"- [x] | A |\n  | - |",
];

/** Every prefix of a source, as a stream delivers it. */
const STREAMED = [
	"Intro\n\n| Queue | Owner |\n| :-- | --: |\n| shared | platform |\n\n- [x] done\n- [ ] open\n\n~~gone~~ text\n",
	"a\n:-:\nb\n\n> | q |\n> | - |\n",
	"- [\r\n  ] a\n\n> - [\n>   ] b\r\n1. [\n   x] c\n",
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
		"- [",
		"1. [",
		"> - [",
		"\n  ",
		"\n> ",
		"\n>   ",
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
	expect(messageGfmRemarkPlugin("~a~")).toBeDefined();
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

test("a single tilde takes the strikethrough syntax, so a link in emphasis around it never changes as the message grows", () => {
	let first = "X*~[link](https://example.com)*";
	expectSame(first);
	expect(draw(first, messageGfmRemarkPlugin(first))).toBe(
		draw(first, messageGfmRemarkPlugin(`${first}\n\n~~yes~~`)),
	);
});

test("nor does it for six thousand generated sources of the marks that matter", () => {
	for (let source of sources(6000)) expectSame(source);
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

// What the choice was before its two scans were made linear, kept here as the reference they are
// compared with: both backtracked quadratically around a character the other repeated class
// could also take (the hyphen of a delimiter row, the space of a task box).
const REFERENCE_DELIMITER_ROW = /^(?=[^\n\r]*[|:])[ \t>|:-]*-[ \t>|:-]*$/m;
const REFERENCE_TASK_BOX = /\[[\s>]*[xX]?[\s>]*\]/;

const TABLE_ONLY = "| a |\n| - |";
const TASKS_ONLY = "- [x] a";
const STRIKETHROUGH_ONLY = "~~a~~";

/** The plugin the reference tests would have given a source: the one for the parts they find. */
function referenceChoice(source: string) {
	let marks: string[] = [];
	if (REFERENCE_DELIMITER_ROW.test(source)) marks.push(TABLE_ONLY);
	if (source.includes("~")) marks.push(STRIKETHROUGH_ONLY);
	if (REFERENCE_TASK_BOX.test(source)) marks.push(TASKS_ONLY);
	return messageGfmRemarkPlugin(marks.join("\n\n"));
}

/** Like `sources`, but made of the characters the two scans are about, and every line ending. */
function scanSources(count: number): string[] {
	let tokens = [
		"|",
		"-",
		"--",
		":",
		">",
		" ",
		"\t",
		"[",
		"]",
		"x",
		"X",
		"a",
		"!",
		"\n",
		"\r",
		"\r\n",
		"\u2028",
		"\u2029",
		"\u00a0",
		"\n> ",
		"\n  ",
	];
	let seed = 987654;
	let next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	let made: string[] = [];
	for (let index = 0; index < count; index++) {
		let length = 1 + Math.floor(next() * 16);
		let text = "";
		for (let token = 0; token < length; token++) text += tokens[Math.floor(next() * tokens.length)];
		made.push(text);
	}
	return made;
}

test("the scans that choose the parts find what they found before they were made linear", () => {
	let generated = [...SOURCES, ...sources(20000), ...scanSources(40000)];
	for (let source of generated) {
		let chosen = messageGfmRemarkPlugin(source);
		if (!/[\u2028\u2029]/.test(source)) {
			expect(chosen, JSON.stringify(source)).toBe(referenceChoice(source));
			continue;
		}
		// A line separator that is not a line ending in Markdown ends a line only to the regular
		// expression: the reference could find a row there that no parser reads, never the reverse.
		let missed = referenceChoice(source);
		if (chosen !== missed) {
			expect(REFERENCE_DELIMITER_ROW.test(source), JSON.stringify(source)).toBe(true);
		}
	}
});

test("nor does reading with the chosen parts differ for sources with every line ending", () => {
	for (let source of scanSources(6000)) expectSame(source);
});

/** The fastest of a few runs, so one pause of a busy machine does not fail a test. */
function fastest(source: string): number {
	let best = Infinity;
	for (let run = 0; run < 3; run++) {
		let start = performance.now();
		messageGfmRemarkPlugin(source);
		best = Math.min(best, performance.now() - start);
	}
	return best;
}

// A Chat message may be 64 KiB and its parts are chosen on the render path; these are 100 KB, past
// that. Each of these took from a few hundred milliseconds to seconds when the scans backtracked;
// linear, they take well under one.
const LONG = 100_000;
const BOUND = 50;
const ADVERSARIAL: Record<string, string> = {
	"a bracket and a long run of spaces": "Read [" + " ".repeat(LONG) + "!",
	"a bracket and a long run of quote marks": "[" + ">".repeat(LONG) + "!",
	"a bracket and a long run of line endings": "[" + " \n".repeat(LONG / 2) + "!",
	"a bracket and a long run of x with spaces": "[" + "x ".repeat(LONG / 2) + "!",
	"many brackets, each with a run of spaces": ("[" + " ".repeat(9)).repeat(LONG / 10),
	"a pipe, a long run of hyphens and a stray mark": "|" + "-".repeat(LONG) + "!",
	"a long line of pipes and hyphens and a stray mark": "|---".repeat(LONG / 4) + "!",
	"a long line of hyphens and colons and a stray mark": "-:".repeat(LONG / 2) + "!",
	"a long run of spaces and a stray mark after a hyphen": " ".repeat(LONG) + "-!",
	"many long lines of hyphens and a stray mark": ("-".repeat(99) + "!\n").repeat(LONG / 100),
	"many short rows with CRLF endings": "|-!\r\n".repeat(LONG / 4),
	"many short rows with CR endings": "|-!\r".repeat(LONG / 3),
	"many rows ended by a line separator": "-\u2028".repeat(LONG / 2),
	"many rows ended by a line separator, and a pipe": "-\u2028".repeat(LONG / 2) + "|",
	"the same line repeated": "- - - -\n".repeat(LONG / 8),
};

test("choosing the parts of a long message takes time in proportion to its length", () => {
	for (let [name, source] of Object.entries(ADVERSARIAL)) {
		expect(source.length, name).toBeGreaterThanOrEqual(LONG - 100);
		expect(fastest(source), name).toBeLessThan(BOUND);
	}
});

test("a task box or delimiter row at the end of a long message still chooses its part", () => {
	let tasks = messageGfmRemarkPlugin(TASKS_ONLY);
	let table = messageGfmRemarkPlugin(TABLE_ONLY);
	let both = messageGfmRemarkPlugin(`${TABLE_ONLY}\n\n${TASKS_ONLY}`);
	expect(tasks).toBeDefined();
	expect(table).toBeDefined();
	expect(both).toBeDefined();
	expect(new Set([tasks, table, both]).size).toBe(3);
	let lines = "text [ \n".repeat(LONG / 8);
	expect(messageGfmRemarkPlugin(lines)).toBeUndefined();
	expect(messageGfmRemarkPlugin(lines + "- [x] a")).toBe(tasks);
	expect(messageGfmRemarkPlugin("[" + " ".repeat(LONG) + "]")).toBe(tasks);
	expect(messageGfmRemarkPlugin("[" + " ".repeat(LONG) + "x" + "\n>".repeat(LONG / 2) + "]"))
		.toBe(tasks);
	expect(messageGfmRemarkPlugin("[" + " ".repeat(LONG) + "xx]")).toBeUndefined();
	let hyphens = "-".repeat(LONG);
	expect(messageGfmRemarkPlugin(hyphens + "\n")).toBeUndefined();
	expect(messageGfmRemarkPlugin("a\n|" + hyphens + "|")).toBe(table);
	expect(messageGfmRemarkPlugin("a\n" + hyphens + ":")).toBe(table);
	expect(messageGfmRemarkPlugin("|" + hyphens + "!\n| - |")).toBe(table);
	expect(messageGfmRemarkPlugin("|" + hyphens + "!\n| - |\n\n- [x] a")).toBe(both);
	expect(messageGfmRemarkPlugin("|" + hyphens + "\r\n|" + hyphens + "|\r\n")).toBe(table);
});
