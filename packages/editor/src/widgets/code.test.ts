/**
 * What a fence says about itself, read without a browser.
 *
 * Deliberately separable from the renderer: everything here decides what to
 * hand a highlighter, and none of it needs one — which is the whole reason
 * these functions are not in the component that calls them.
 */

import { describe, expect, it } from "bun:test";
import { DIFF_LANGUAGE, MERMAID_LANGUAGE, SEECODE_LANGUAGE } from "@chopin/dialect";

import {
	describeDiagramError,
	fileNameOf,
	jumpTo,
	kindOf,
	languageOptions,
	LANGUAGES,
	repaired,
	titled,
	titleOf,
} from "./code";

describe("what a fence is", () => {
	it("tells rendered languages apart from ordinary code", () => {
		expect(kindOf(MERMAID_LANGUAGE)).toBe("mermaid");
		expect(kindOf(SEECODE_LANGUAGE)).toBe("seecode");
		expect(kindOf(DIFF_LANGUAGE)).toBe("diff");
		expect(kindOf("openui-options")).toBe("openui-options");
		expect(kindOf("typescript")).toBe("code");
	});

	/**
	 * A fence nobody named renders nothing. Colouring uncoloured text beside
	 * the same uncoloured text is two of the same thing, and an invitation to
	 * edit the copy that is not the document.
	 */
	it("has nothing to draw for a fence with no language", () => {
		expect(kindOf("")).toBe("plain");
	});

	/** One spelling, so the agent cannot copy a second one back at us. */
	it("does not accept another spelling of diff", () => {
		expect(kindOf("patch")).toBe("code");
		expect(kindOf("udiff")).toBe("code");
	});
});

describe("a fence's title", () => {
	it("reads the two spellings a generator is likely to have written", () => {
		expect(titleOf('title="a.js"')).toBe("a.js");
		expect(titleOf('filename="a.js"')).toBe("a.js");
		expect(titleOf("title='a.js'")).toBe("a.js");
	});

	it("finds one among the rest of the info string", () => {
		expect(titleOf('collapsed title="apps/server/src/main.ts" {1,3}'))
			.toBe("apps/server/src/main.ts");
	});

	/**
	 * Quotes are required. An unquoted value cannot contain a space, so
	 * half-supporting it would mean a path with one in it silently losing its
	 * tail — and a plan is full of paths somebody typed.
	 */
	it("refuses a value it would have to guess the end of", () => {
		expect(titleOf("title=a.js")).toBeUndefined();
		expect(titleOf("title=my file.js")).toBeUndefined();
	});

	it("is not fooled by a word ending in title", () => {
		expect(titleOf('subtitle="a.js"')).toBeUndefined();
	});

	it("has nothing to say about an empty info string", () => {
		expect(titleOf("")).toBeUndefined();
		expect(titled("")).toBe(false);
		expect(titled('title="a.js"')).toBe(true);
	});
});

describe("the name handed to the renderer", () => {
	/**
	 * The renderer works in files: it shows the name, and falls back to it
	 * when nothing else says what the language is. A fence usually has no
	 * name, so one is invented — invented rather than omitted, because an
	 * empty header reads as a missing file rather than as a snippet.
	 */
	it("invents one from the language when the fence has no title", () => {
		expect(fileNameOf("ts", "")).toBe("snippet.ts");
		expect(fileNameOf("", "")).toBe("snippet.txt");
	});

	it("prefers what the author wrote", () => {
		expect(fileNameOf("ts", 'title="apps/web/src/main.tsx"')).toBe("apps/web/src/main.tsx");
	});
});

describe("the languages on offer", () => {
	it("offers both of the fences that render as something else", () => {
		let ids = LANGUAGES.map(([id]) => id);
		expect(ids).toContain(MERMAID_LANGUAGE);
		expect(ids).toContain(SEECODE_LANGUAGE);
		expect(ids).toContain(DIFF_LANGUAGE);
	});

	/**
	 * The list is written out by hand, and a duplicate in it is a `<select>`
	 * with two identical options, one of which can never be chosen.
	 */
	it("names each language once", () => {
		let ids = LANGUAGES.map(([id]) => id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	/**
	 * The ids are the highlighter's own, and it has no capitals and no spaces
	 * anywhere in its registry. An id that does not match one is a language
	 * that silently renders as plain text.
	 */
	it("spells them the way the highlighter does", () => {
		for (let [id, label] of LANGUAGES) {
			expect(id).toMatch(/^[a-z0-9+#-]+$/);
			expect(label).not.toBe("");
		}
	});

	/** Nothing offers the empty language: the control has its own entry for it. */
	it("leaves plain text to the control", () => {
		expect(LANGUAGES.map(([id]) => id)).not.toContain("");
	});
});

/**
 * The renderer's parser is strict, deliberately: half a patch drawn as a diff
 * is a change nobody made. What arrives in a plan is written by a model
 * quoting a change, and gets the arithmetic wrong. Both are true, so what is
 * handed over is repaired first and what cannot be repaired is refused.
 */
describe("repairing a patch on the way to the renderer", () => {
	it("counts the lines a hunk actually has", () => {
		let patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1,9 +1,9 @@\n a\n-b\n+c\n+d\n";
		// Three on the way in, four on the way out, whatever the header said.
		expect(repaired(patch)).toContain("@@ -1,2 +1,3 @@");
	});

	it("keeps what the hunk was inside", () => {
		let patch = "--- a/x.ts\n+++ b/x.ts\n@@ -20,1 +20,1 @@ export function open() {\n-a\n+b\n";
		expect(repaired(patch)).toContain("@@ -20,1 +20,1 @@ export function open() {");
	});

	/**
	 * Every editor strips trailing whitespace, so an unchanged blank line
	 * arrives as an empty line — which under the format is the end of the
	 * hunk rather than a line in it.
	 */
	it("reads a stripped blank line as the unchanged line it was", () => {
		let patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n";
		let out = repaired(patch);
		expect(out).toContain("@@ -1,3 +1,3 @@");
		expect(out.split("\n")[4]).toBe(" ");
	});

	it("takes the prefixes off a plain unified diff, which the renderer will not", () => {
		let patch = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
		expect(repaired(patch)).toContain("--- src/x.ts\n+++ src/x.ts");
	});

	/** Git's own form names its files on its own line, prefixes and all. */
	it("leaves a git patch's names alone", () => {
		let patch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
		expect(repaired(patch)).toContain("--- a/x.ts");
	});

	/**
	 * Deleting a line that begins `-- ` writes a line that begins `--- `, and
	 * SQL is full of them. Where it sits is what tells it apart from a header:
	 * inside a hunk it is somebody's query and stays exactly as it was.
	 */
	it("does not mistake a deleted line for a filename", () => {
		let patch =
			"--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- drop table users;\n+-- keep them;\n c\n";
		let out = repaired(patch);
		expect(out).toContain("--- drop table users;");
		expect(out).toContain("--- q.sql\n+++ q.sql");
	});

	/**
	 * A name has to look like git's before it is rewritten as though it were:
	 * a patch about a directory actually called `a` keeps it, and so does one
	 * written with some other convention entirely.
	 */
	it("only takes off a prefix it recognises", () => {
		let patch = "--- old/x.ts\n+++ new/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
		expect(repaired(patch)).toContain("--- old/x.ts\n+++ new/x.ts");
	});

	/** The pair is what says a new file starts, so a hunk cannot swallow one. */
	it("ends a hunk where the next file begins", () => {
		let patch = "--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/two.ts\n+++ b/two.ts\n"
			+ "@@ -1 +1 @@\n-c\n+d\n";
		let out = repaired(patch);
		expect(out).toContain("@@ -1,1 +1,1 @@\n-a\n+b\n--- two.ts");
		expect(out.match(/@@ -1,1 \+1,1 @@/g)).toHaveLength(2);
	});

	it("leaves what was never a patch alone, for the parser to refuse", () => {
		expect(repaired("- let a = 1;\n+ let a = 2;")).toBe("- let a = 1;\n+ let a = 2;");
		expect(repaired("we should change the thing")).toBe("we should change the thing");
	});

	/** A trailing newline is not a line, and counting it would invent one. */
	it("does not read the last newline as an unchanged line", () => {
		let patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
		expect(repaired(patch)).toBe("--- x.ts\n+++ x.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n");
	});
});

describe("languageOptions", () => {
	it("starts with plain text and lists every language once", () => {
		let options = languageOptions("typescript");
		expect(options[0]).toEqual(["", "Plain text"]);
		expect(options).toHaveLength(LANGUAGES.length + 1);
	});

	it("keeps an unlisted language selectable, right after plain text", () => {
		let options = languageOptions("brainfuck");
		expect(options[1]).toEqual(["brainfuck", "brainfuck"]);
		expect(options).toHaveLength(LANGUAGES.length + 2);
	});
});

describe("jumpTo", () => {
	let options = languageOptions("typescript");
	let at = (id: string) => options.findIndex(([option]) => option === id);

	it("reaches a diagram by its label or by Mermaid", () => {
		expect(jumpTo(options, 0, "d")).toBe(at(MERMAID_LANGUAGE));
		expect(jumpTo(options, 0, "M")).toBe(at(MERMAID_LANGUAGE));
	});

	it("moves on to the next match, and wraps round", () => {
		let diagram = at(MERMAID_LANGUAGE);
		expect(jumpTo(options, diagram, "m")).toBe(at("markdown"));
		expect(jumpTo(options, at("markdown"), "m")).toBe(diagram);
	});

	it("finds nothing for a letter no row starts with", () => {
		expect(jumpTo(options, 0, "q")).toBe(-1);
	});
});

describe("describeDiagramError", () => {
	it("drops the echoed source for an unknown diagram type", () => {
		let result = describeDiagramError(
			"No diagram type detected matching given configuration for text: nope\nmore",
		);
		expect(result).toEqual({
			summary: "The diagram type is not recognised.",
			excerpt: "",
			expected: "",
		});
	});

	it("splits a parse error into summary, excerpt and expectation", () => {
		let result = describeDiagramError(
			"Parse error on line 3:\n...a -> b\n-----^\nExpecting '+', '-', 'ACTOR', got 'NEWLINE'",
		);
		expect(result.summary).toBe("Parse error on line 3");
		expect(result.excerpt).toBe("...a -> b\n-----^");
		expect(result.expected).toBe("Expecting '+', '-', 'ACTOR', got 'NEWLINE'");
	});

	it("handles a parse error without a caret line", () => {
		let result = describeDiagramError("Parse error on line 2:\nExpecting 'X'\nfoo");
		expect(result).toEqual({
			summary: "Parse error on line 2",
			excerpt: "",
			expected: "Expecting 'X' foo",
		});
	});

	it("keeps a single-line message as the summary", () => {
		expect(describeDiagramError("Something odd")).toEqual({
			summary: "Something odd",
			excerpt: "",
			expected: "",
		});
	});

	it("handles Windows line endings and a caret with no dashes", () => {
		let result = describeDiagramError(
			"Lexical error on line 2. Unrecognized text.\r\n...\r\nA -->\r\n^\r\nExpecting 'X', got 'Y'",
		);
		expect(result.summary).toBe("Lexical error on line 2. Unrecognized text.");
		expect(result.excerpt).toBe("A -->\n^");
		expect(result.expected).toBe("Expecting 'X', got 'Y'");
	});

	it("never renders an empty summary", () => {
		expect(describeDiagramError("").summary).toBe("The diagram could not be parsed.");
	});
});
