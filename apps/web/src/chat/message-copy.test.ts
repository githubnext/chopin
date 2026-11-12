import { expect, test } from "bun:test";

import { plainTextOf } from "./message-copy";

import type { Chat } from "@chopin/protocol";

test("plain text is the Markdown as the page draws it", () => {
	expect(plainTextOf("**Bold**, *italic* and `code`")).toBe("Bold, italic and code");
	expect(plainTextOf("[the docs](https://example.com/docs) say so")).toBe("the docs say so");
	expect(plainTextOf("# A title\n\nBody text")).toBe("A title\n\nBody text");
	expect(plainTextOf("> quoted\n\nafter")).toBe("quoted\n\nafter");
	expect(plainTextOf("```ts\nlet answer = 42;\n```")).toBe("let answer = 42;");
});

test("plain text lists put each item on a line of its own, as the browser copies a rendered list", () => {
	expect(plainTextOf("* first\n* second")).toBe("first\nsecond");
	expect(plainTextOf("1. one\n2. two")).toBe("one\ntwo");
	expect(plainTextOf("3. three\n4. four")).toBe("three\nfour");
	expect(plainTextOf("* parent\n  * child")).toBe("parent\nchild");
	expect(plainTextOf("Lead\n\n* a\n* b\n\nTail")).toBe("Lead\n\na\nb\n\nTail");
});

test("plain text keeps every mention as written, as the page draws it", () => {
	expect(plainTextOf("ask @chopin about it")).toBe("ask @chopin about it");
	expect(plainTextOf("thanks @mina, @Sam and @bo-li")).toBe("thanks @mina, @Sam and @bo-li");
});

test("plain text breaks a line where the page does and joins a soft break with a space", () => {
	expect(plainTextOf("one\ntwo")).toBe("one two");
	expect(plainTextOf("one  \ntwo")).toBe("one\ntwo");
	expect(plainTextOf("one\n\ntwo")).toBe("one\n\ntwo");
});

test("plain text leaves out what the page does not draw", () => {
	expect(plainTextOf("keep ![alt](https://example.com/p.png)")).toBe("keep");
	expect(plainTextOf("")).toBe("");
});

test("plain text collapses whitespace as the page does, also where something the page does not draw stood", () => {
	expect(plainTextOf("a  b")).toBe("a b");
	expect(plainTextOf("x   y\tz")).toBe("x y z");
	expect(plainTextOf("image ![alt](https://example.com/image.png) end")).toBe("image end");
	expect(plainTextOf("keep <b>x</b>  and <i>y</i>")).toBe("keep <b>x</b> and <i>y</i>");
	expect(plainTextOf("a **bold**  *and* `code`   tail")).toBe("a bold and code tail");
	expect(plainTextOf("one  \n  two  three")).toBe("one\ntwo three");
	expect(plainTextOf("first  line\n\nsecond   line")).toBe("first line\n\nsecond line");
	expect(plainTextOf("* a  b\n* c   d")).toBe("a b\nc d");
});

test("plain text keeps the whitespace the page keeps in a code block", () => {
	expect(plainTextOf("```\na  b\n\tc\n```")).toBe("a  b\n\tc");
});

test("plain text shows a reference as its label", () => {
	let source = "see #Design for the plan";
	let reference: Chat.Reference = {
		id: "ref-1",
		kind: "document",
		channelId: "channel-1",
		start: 4,
		end: 11,
		label: "#Design",
		href: "/documents/octo-org/score/design",
		repositoryId: "repository-1",
		observedRevision: 1,
		observedSourceHash: "sha256:x",
	};
	expect(plainTextOf(source, [reference])).toBe("see #Design for the plan");
});

test("plain text starts with what the page draws before the text, such as the Planner address", () => {
	expect(plainTextOf("explain the cache", undefined, "@chopin")).toBe("@chopin explain the cache");
	expect(plainTextOf("", undefined, "@chopin")).toBe("@chopin");
	expect(plainTextOf("explain the cache", undefined, undefined)).toBe("explain the cache");
});

test("plain text reads strikethrough, task lists and tables as MarkdownText draws them, and leaves footnotes and bare URLs as text", () => {
	expect(plainTextOf("~~gone~~ and ~one~ and ~~two words~~")).toBe("gone and ~one~ and two words");
	expect(plainTextOf("keep ~~~three tildes~~~ plain")).toBe("keep ~~~three tildes~~~ plain");
	expect(plainTextOf("- [x] done\n- [ ] open\n- plain")).toBe("done\nopen\nplain");
	expect(plainTextOf("1. [X] numbered task")).toBe("numbered task");
	expect(plainTextOf("[x] outside a list and - [xx] two")).toBe(
		"[x] outside a list and - [xx] two",
	);
	expect(plainTextOf("| Queue | Owner |\n| :-- | --: |\n| shared | ~~old~~ live |")).toBe(
		"Queue\tOwner\nshared\told live",
	);
	expect(plainTextOf("A | B\n:- | -:\n1 | 2")).toBe("A\tB\n1\t2");
	expect(plainTextOf("A | B\n- | -\n1 | 2")).toBe("A | B\n\n| - 1 | 2");
	expect(plainTextOf("a\n:-")).toBe("a");
	expect(plainTextOf("> | A | B |\n> | - | - |\n> | 1 | 2 |")).toBe("A\tB\n1\t2");
	expect(plainTextOf("a | b without a delimiter row")).toBe("a | b without a delimiter row");
	expect(plainTextOf("Footnote[^1] and https://example.com\n\n[^1]: The note.")).toBe(
		"Footnote[^1] and https://example.com\n\n[^1]: The note.",
	);
});

test("plain text keeps text in angle brackets as written, as the page draws it", () => {
	expect(plainTextOf("Returns Option<u64> or Vec<Result<T, E>>")).toBe(
		"Returns Option<u64> or Vec<Result<T, E>>",
	);
	expect(plainTextOf("x < y && y > z")).toBe("x < y && y > z");
	expect(plainTextOf("<not-a-tag>\n**bold**")).toBe("<not-a-tag> bold");
});
