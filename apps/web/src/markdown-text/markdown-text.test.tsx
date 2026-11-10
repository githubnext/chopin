import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { defaultComponents } from "./default-components";
import { MarkdownText } from "./markdown-text";

import type { ComponentProps, ComponentType } from "react";
import type { SyntaxHighlighterProps } from "./markdown-text";

function draw(props: Partial<ComponentProps<typeof MarkdownText>> & { text: string }): string {
	return renderToStaticMarkup(createElement(MarkdownText, props));
}

test("the text and its status are props, and the status is the root's data-status", () => {
	expect(draw({ text: "Hello" })).toBe(
		'<div data-status="complete" class="aui-md"><p class="aui-md-p">Hello</p></div>',
	);
	for (let status of ["running", "complete", "incomplete"] as const) {
		expect(draw({ status, text: "Hello" })).toContain(`<div data-status="${status}"`);
	}
});

test("every default element carries its aui-md class, and GitHub's tables, strikethrough and tasks render", () => {
	let markup = draw({
		text: [
			"# One",
			"",
			"a **b** [c](https://example.com) `d`",
			"",
			"> quote",
			"",
			"- x",
			"1. y",
			"",
			"---",
			"",
			"| A | B |",
			"| --- | :-: |",
			"| 1 | 2 |",
			"",
			"~~gone~~",
			"",
			"- [x] done",
			"- [ ] open",
			"",
			"```ts",
			"let a = 1;",
			"```",
		].join("\n"),
	});
	for (
		let name of [
			"h1",
			"p",
			"strong",
			"a",
			"inline-code",
			"blockquote",
			"ul",
			"ol",
			"li",
			"hr",
			"table-wrapper",
			"table",
			"th",
			"td",
			"tr",
			"pre",
		]
	) expect(markup).toContain(`aui-md-${name}`);
	expect(markup).toContain("<del>gone</del>");
	expect(markup.match(/<input [^>]*type="checkbox"/g)).toHaveLength(2);
	// A column's alignment arrives as the cell's own style.
	expect(markup).toContain('<td class="aui-md-td" style="text-align:center">2</td>');
});

test("components merge onto the defaults and the rest keep theirs", () => {
	let markup = draw({
		components: { a: ({ children }) => <a data-mine="">{children}</a> },
		text: "[x](https://example.com) and **y**",
	});
	expect(markup).toContain('<a data-mine="">x</a>');
	expect(markup).toContain('<strong class="aui-md-strong">y</strong>');
});

test("raw HTML never reaches the output as markup when it is skipped, and shows as text when it is not", () => {
	let text = "Before <script>alert(1)</script> <img src=x onerror=alert(1)> after";
	let skipped = draw({ skipHtml: true, text });
	expect(skipped).not.toContain("<script");
	expect(skipped).not.toContain("<img");
	let shown = draw({ text });
	expect(shown).not.toContain("<script");
	expect(shown).not.toContain("<img");
	expect(shown).toContain("&lt;script&gt;");
});

test("a link is as written: no script, data or javascript target survives", () => {
	let markup = draw({
		text: "[a](javascript:alert(1)) [b](data:text/html;base64,AAAA) [c](https://example.com)",
	});
	expect(markup).not.toContain("javascript:");
	expect(markup).not.toContain("data:text/html");
	expect(markup).toContain('href="https://example.com"');
});

test("the phrase container, its attributes and a lead before the first block", () => {
	let markup = draw({
		containerComponent: "span",
		containerProps: { "data-mine": "yes" },
		lead: <b data-lead="">@x</b>,
		text: "plain",
	});
	expect(markup).toBe(
		'<span data-status="complete" data-mine="yes" class="aui-md"><b data-lead="">@x</b><p class="aui-md-p">plain</p></span>',
	);
});

let Diagram = ({ code, language }: SyntaxHighlighterProps) => (
	<figure data-diagram={language}>{code}</figure>
);

test("a fence is dispatched by its language to a header and a highlighter of its own", () => {
	let markup = draw({
		componentsByLanguage: { mermaid: { CodeHeader: () => null, SyntaxHighlighter: Diagram } },
		text: "```mermaid\nflowchart LR\n```\n\n```ts\nlet a = 1;\n```",
	});
	expect(markup).toContain('<figure data-diagram="mermaid">flowchart LR\n</figure>');
	// Another language keeps the default header, with its language and a copy button, above its code.
	expect(markup).toContain('<span class="aui-code-header-language">ts</span>');
	expect(markup).toContain('aria-label="Copy code"');
	expect(markup).toContain(
		'<pre class="aui-md-pre"><code class="language-ts">let a = 1;\n</code></pre>',
	);
	expect(markup.match(/aui-code-header-root/g)).toHaveLength(1);
});

test("a fence with no language is plain text with a header that names none", () => {
	let markup = draw({ text: "```\nplain\n```" });
	expect(markup).toContain('<span class="aui-code-header-language"></span>');
	expect(markup).not.toContain("language-");
});

test("every prefix of a streamed message draws without error and settles to the whole", () => {
	let whole =
		"# Plan\n\nWe **keep** `x` and [link](https://example.com/a)\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nlet a = 1;\n```\n";
	let drawn = new Set<string>();
	let last = "";
	for (let end = 0; end <= whole.length; end++) {
		last = draw({ status: "running", text: whole.slice(0, end) });
		drawn.add(last);
	}
	// Most prefixes draw something new, and the last is what the whole text draws.
	expect(drawn.size).toBeGreaterThan(20);
	expect(last).toBe(draw({ status: "running", text: whole }));
	expect(draw({ status: "complete", text: whole })).toContain('data-status="complete"');
	// An unterminated fence is already a block of code while it arrives.
	expect(draw({ status: "running", text: "```ts\nlet a" })).toContain(
		'<code class="language-ts">let a',
	);
});

test("the element is the standalone one: nothing in it imports assistant-ui's runtime", () => {
	let files = readdirSync(new URL(".", import.meta.url)).filter(name =>
		/\.tsx?$/.test(name) && !/\.test\./.test(name)
	);
	expect(files).toContain("markdown-text.tsx");
	for (let file of files) {
		let source = readFileSync(new URL(file, import.meta.url), "utf8");
		let imports = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(match =>
			match[1]!
		);
		expect(imports.filter(name => name.startsWith("@assistant-ui/")), file).toEqual([]);
		for (let word of ["AssistantRuntimeProvider", "useAui", "useMessagePartText", "useSmooth("]) {
			// Upstream's names appear only in the comments that say what was replaced.
			let code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
			expect(code, `${file} uses ${word}`).not.toContain(word);
		}
	}
	let manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	let dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
	expect(dependencies.filter(name => name.startsWith("@assistant-ui/"))).toEqual([]);
});

/** What one of the default elements draws with the props react-markdown would give it. */
function element(component: unknown, props: object): string {
	return renderToStaticMarkup(createElement(component as ComponentType<object>, props));
}

test("a class a component is given joins its aui-md class, as upstream's elements do", () => {
	let tags = [
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"p",
		"a",
		"blockquote",
		"ul",
		"ol",
		"hr",
		"th",
		"td",
		"tr",
		"li",
		"strong",
		"sup",
		"pre",
	] as const;
	for (let tag of tags) {
		let markup = element(defaultComponents[tag], { className: "given" });
		expect(markup, tag).toContain(`class="aui-md-${tag} given"`);
	}
	expect(element(defaultComponents.table, { className: "given" })).toContain(
		'<table class="aui-md-table given">',
	);
	// A task list's classes from the parser keep the list's own.
	expect(element(defaultComponents.ul, { className: "contains-task-list" })).toBe(
		'<ul class="aui-md-ul contains-task-list"></ul>',
	);
	expect(draw({ text: "- [x] done" })).toContain('<ul class="aui-md-ul contains-task-list">');
	expect(draw({ text: "- [x] done" })).toContain('<li class="aui-md-li task-list-item">');
});

test("the root's class, its aui-md class and the container's own class all stay", () => {
	expect(
		draw({
			className: "mine",
			containerProps: { className: "theirs", "data-x": "1" },
			text: "t",
		}),
	).toBe(
		'<div data-status="complete" data-x="1" class="mine aui-md theirs"><p class="aui-md-p">t</p></div>',
	);
	expect(draw({ containerProps: { className: "theirs" }, text: "t" })).toContain(
		'class="aui-md theirs"',
	);
});
