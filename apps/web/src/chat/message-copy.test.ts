import { expect, test } from "bun:test";

import { markdownOf, plainTextOf } from "./message-copy";

import type { Chat } from "@chopin/protocol";

test("Markdown copy is the stored text untouched, spaces and syntax included", () => {
	let text = "  **Bold**, `code` and [a link](https://example.com/a?b=1).\n\n- one\n- two  \n";
	expect(markdownOf({ text })).toBe(text);
	expect(markdownOf({ text, to: "room" })).toBe(text);
	expect(markdownOf({ text: "" })).toBe("");
});

test("Markdown copy keeps raw HTML, images and an @chopin written inside prose", () => {
	let text = "Ask @chopin here <b>x</b> ![alt](https://example.com/p.png)";
	expect(markdownOf({ text })).toBe(text);
});

test("Markdown copy leaves out only the Planner address the page draws from `to`", () => {
	expect(markdownOf({ text: "@chopin explain the cache", to: "planner" })).toBe(
		"explain the cache",
	);
	// What follows is the author's, newline and all.
	expect(markdownOf({ text: "  @Chopin\nexplain", to: "planner" })).toBe("\nexplain");
	expect(markdownOf({ text: "explain the cache", to: "planner" })).toBe("explain the cache");
	// Not addressed to the Planner: an author's own @chopin stays.
	expect(markdownOf({ text: "@chopin explain", to: "room" })).toBe("@chopin explain");
	expect(markdownOf({ text: "@chopin explain" })).toBe("@chopin explain");
	// A mention in the middle is prose, and `chopinx` is not the address.
	expect(markdownOf({ text: "ask @chopin, then @chopinx", to: "planner" })).toBe(
		"ask @chopin, then @chopinx",
	);
});

test("plain text is the Markdown as the page draws it", () => {
	expect(plainTextOf("**Bold**, *italic* and `code`")).toBe("Bold, italic and code");
	expect(plainTextOf("[the docs](https://example.com/docs) say so")).toBe("the docs say so");
	expect(plainTextOf("# A title\n\nBody text")).toBe("A title\n\nBody text");
	expect(plainTextOf("> quoted\n\nafter")).toBe("quoted\n\nafter");
	expect(plainTextOf("```ts\nlet answer = 42;\n```")).toBe("let answer = 42;");
});

test("plain text lists keep their markers, numbers and nesting", () => {
	expect(plainTextOf("- first\n- second")).toBe("• first\n• second");
	expect(plainTextOf("1. one\n2. two")).toBe("1. one\n2. two");
	expect(plainTextOf("3. three\n4. four")).toBe("3. three\n4. four");
	expect(plainTextOf("- parent\n  - child")).toBe("• parent\n  • child");
});

test("plain text breaks a line where the page does and joins a soft break with a space", () => {
	expect(plainTextOf("one\ntwo")).toBe("one two");
	expect(plainTextOf("one  \ntwo")).toBe("one\ntwo");
	expect(plainTextOf("one\n\ntwo")).toBe("one\n\ntwo");
});

test("plain text leaves out what the page does not draw", () => {
	expect(plainTextOf("keep <b>x</b> ![alt](https://example.com/p.png)")).toBe("keep x");
	expect(plainTextOf("ask @chopin about it")).toBe("ask about it");
	expect(plainTextOf("thanks @mina")).toBe("thanks Mina");
	expect(plainTextOf("")).toBe("");
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
