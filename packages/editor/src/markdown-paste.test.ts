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

import {
	$pasteMarkdown,
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
