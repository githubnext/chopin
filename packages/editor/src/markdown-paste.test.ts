import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isRangeSelection,
} from "lexical";

import { $createCodeBlockNode, $exportPlan, registry } from "@chopin/dialect";

import { limits } from "@chopin/dialect";

import {
	$pasteMarkdown,
	isPlainPasteKey,
	looksLikeMarkdown,
	pastedMarkdown,
	prefersMarkdown,
} from "./markdown-paste";

import type { LexicalNode } from "lexical";

const REGISTRY = registry();

function paste(text: string, build: () => LexicalNode = () => $createParagraphNode()) {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(error) {
			throw error;
		},
	});
	let handled = false;
	editor.update(() => {
		let block = build();
		$getRoot().append(block);
		block.selectEnd();
		let selection = $getSelection();
		if ($isRangeSelection(selection)) handled = $pasteMarkdown(selection, text);
	}, { discrete: true });
	let source = editor.getEditorState().read(() => $exportPlan({ registry: REGISTRY }));
	return { handled, source };
}

test("recognises clear block and inline syntax", () => {
	for (
		let text of [
			"## Heading",
			"- one\n- two",
			"1. one\n2. two",
			"- [ ] task",
			"> quoted",
			"```ts\nlet a = 1;\n```",
			"| a | b |\n| - | - |\n| 1 | 2 |",
			"Some **bold** text",
			"A [link](https://example.com)",
			"Run `bun test`",
			"Not ~~this~~",
		]
	) expect(looksLikeMarkdown(text), text).toBe(true);
});

test("leaves ordinary prose alone", () => {
	for (
		let text of [
			"Just a sentence.",
			"#1 priority is shipping",
			"5 * 3 * 2 = 30",
			"a ** b ** c",
			"- a lone dash line",
			"snake_case_name and __init",
			"It costs $5 and $10",
			"```\nunclosed fence",
			"Two\n\nparagraphs of prose",
			"1986. A great year.\n1987. Another one.",
			"snake __init__ name",
		]
	) expect(looksLikeMarkdown(text), text).toBe(false);
});

test("reads plain text and structureless HTML as Markdown, but not rich HTML", () => {
	expect(prefersMarkdown(["text/plain"], "")).toBe(true);
	expect(prefersMarkdown(["text/plain", "text/html"], "<div><span>## a</span><br></div>")).toBe(
		true,
	);
	expect(prefersMarkdown(["text/plain", "text/html"], "<h2>a</h2>")).toBe(false);
	expect(prefersMarkdown(["text/plain", "text/html"], "<p>a <b>b</b></p>")).toBe(false);
	expect(prefersMarkdown(["text/plain", "application/x-lexical-editor"], "")).toBe(false);
	expect(prefersMarkdown(["text/plain", "Files"], "")).toBe(false);
	expect(prefersMarkdown(["text/html"], "")).toBe(false);
});

test("keeps components and expressions literal", () => {
	let tree = pastedMarkdown(
		'## Notes\n\n<Questionnaire id="01K0N4W3B7P27CBAEC7A8C8WEA">\n\n<Callout>hi</Callout> {1 + 1}',
	);
	expect(tree?.children.map(node => node.type)).toEqual(["heading", "paragraph", "paragraph"]);
	expect(JSON.stringify(tree)).not.toContain("mdxJsx");
	expect(JSON.stringify(tree)).toContain("<Questionnaire");
});

test("keeps single dollars as text", () => {
	let tree = pastedMarkdown("**Cost** is $5 and $10, $$x^2$$");
	expect(JSON.stringify(tree)).not.toContain('"inlineMath","value":"5');
	expect(JSON.stringify(tree)).toContain("$5 and $10");
});

test("falls back when the dialect would refuse the result", () => {
	expect(pastedMarkdown("A [link](javascript:alert(1)) **x**")).toBeUndefined();
});

test("inserts headings, lists, code, tables and links as blocks", () => {
	let { handled, source } = paste(
		[
			"## Pasted heading",
			"",
			"- first **bold** item",
			"- second [link](https://example.com)",
			"",
			"```ts",
			"let a = 1;",
			"```",
			"",
			"| a | b |",
			"| - | - |",
			"| 1 | 2 |",
		].join("\n"),
	);
	expect(handled).toBe(true);
	expect(source).toBe(
		"## Pasted heading\n\n- first **bold** item\n- second [link](https://example.com)\n\n"
			+ "```ts\nlet a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
	);
});

test("inline Markdown joins the current paragraph", () => {
	let { handled, source } = paste(
		"and **bold**",
		() => $createParagraphNode().append($createTextNode("Start ")),
	);
	expect(handled).toBe(true);
	expect(source.trim()).toBe("Start and **bold**");
});

test("pastes literally inside a code block", () => {
	let { handled } = paste("## Heading", () => $createCodeBlockNode("md", "x"));
	expect(handled).toBe(false);
});

test("refuses URLs the server would reject from a new batch", () => {
	let hidden = `https://ex${String.fromCharCode(0x200b)}ample.com/a.png`;
	expect(pastedMarkdown(`Look **here** ![i](${hidden})`)).toBeUndefined();
	expect(pastedMarkdown("A [link](//evil.example) **x**")).toBeUndefined();
	expect(pastedMarkdown("A [link](\\\\evil.example) **x**")).toBeUndefined();
	expect(pastedMarkdown("![i](https://example.com/a.png) **x**")).toBeDefined();
});

test("refuses a paste that would push the document past its limits", () => {
	let image = "**x** ![i](https://example.com/a.png)";
	expect(pastedMarkdown(image, { images: limits.MAX_IMAGES - 1, depth: 2 })).toBeDefined();
	expect(pastedMarkdown(image, { images: limits.MAX_IMAGES, depth: 2 })).toBeUndefined();

	let nested = "- a\n  - b\n    - c";
	expect(pastedMarkdown(nested, { images: 0, depth: 2 })).toBeDefined();
	expect(pastedMarkdown(nested, { images: 0, depth: limits.MAX_DEPTH - 2 })).toBeUndefined();

	let large = "- item\n".repeat(Math.ceil(64 * 1024 / 7) + 1);
	expect(looksLikeMarkdown(large)).toBe(false);
	expect(pastedMarkdown(large)).toBeUndefined();
	let multibyte = "**é** ".repeat(Math.ceil(limits.MAX_SOURCE_BYTES / 8) + 1);
	expect(multibyte.length).toBeGreaterThan(limits.MAX_SOURCE_BYTES / 2);
	expect(pastedMarkdown(multibyte)).toBeUndefined();
});

test("detection stays fast on pathological lines", () => {
	for (let unit of ["a|", "[x](", "**a", "~~a", "[[[", "```\n"]) {
		let text = unit.repeat(Math.floor(128 * 1024 / unit.length));
		let started = performance.now();
		looksLikeMarkdown(text);
		expect(performance.now() - started, unit).toBeLessThan(200);
	}
});

test("keeps the numbers of a list that does not start at one", () => {
	let { source } = paste("## Years\n\n1986. A **great** year.\n1987. Another one.");
	expect(source).toBe("## Years\n\n1986\\. A **great** year.\n\n1987\\. Another one.\n");
	expect(paste("1. one\n2. two").source).toBe("1. one\n2. two\n");
});

test("ends a list at an unindented line", () => {
	let { source } = paste("Remember:\n- tickets\n- hotel\nThanks");
	expect(source).toBe("Remember:\n\n- tickets\n- hotel\n\nThanks\n");
	expect(paste("- a\n  more of a\n- b").source).toBe("- a\n  more of a\n- b\n");
});

test("recognises plain-text paste shortcuts on any layout", () => {
	let key = { shiftKey: true, metaKey: true, ctrlKey: false, key: "v", code: "KeyV" };
	expect(isPlainPasteKey(key)).toBe(true);
	expect(isPlainPasteKey({ ...key, key: "м" })).toBe(true);
	expect(isPlainPasteKey({ ...key, key: "◊" })).toBe(true);
	expect(isPlainPasteKey({ ...key, metaKey: false, ctrlKey: true })).toBe(true);
	expect(isPlainPasteKey({ ...key, shiftKey: false })).toBe(false);
});

test("a fragmented paste falls back to literal text quickly", () => {
	let started = performance.now();
	expect(paste("**a** b\n\n".repeat(450)).handled).toBe(true);
	expect(performance.now() - started).toBeLessThan(1_000);
	expect(pastedMarkdown("**a**".repeat(150))).toBeDefined();
	for (
		let text of [
			"**a".repeat(4_000),
			"**a".repeat(Math.floor(128 * 1024 / 3)),
			"`a` ".repeat(1_000),
			"## a\n\n" + "a *".repeat(5_000),
			"- [x](https://example.com)\n".repeat(1_500),
		]
	) {
		started = performance.now();
		let { handled } = paste(text);
		expect(performance.now() - started, text.slice(0, 20)).toBeLessThan(1_000);
		expect(handled, text.slice(0, 20)).toBe(false);
	}
});

function section(index: number): string {
	return (
		`## Section ${index}\n\nSome **bold** prose with a [link](https://example.com/${index}).\n\n`
		+ "- first item\n- second item\n\n"
	);
}

test("an ordinary long document converts", () => {
	let text = Array.from({ length: 200 }, (_, index) => section(index)).join("");
	expect(text.length).toBeGreaterThan(20 * 1024);
	let started = performance.now();
	let { handled, source } = paste(text);
	expect(performance.now() - started).toBeLessThan(1_000);
	expect(handled).toBe(true);
	expect(source).toContain("## Section 199\n\nSome **bold** prose");
});
