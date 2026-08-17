import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageMarkdown } from "./markdown";

let PARTICIPANT_MESSAGE = [
	"**Bold** and *italic* with [the docs](https://example.com).",
	"",
	"- first",
	"- second",
	"",
	"1. one",
	"2. two",
	"",
	"> quoted",
	"",
	"Use `bun test`.",
	"",
	"```ts",
	"let answer = 42;",
	"```",
	"",
	"# Ordinary message text",
	"",
	"![remote](https://example.invalid/pixel.png)",
	'<img src="https://example.invalid/raw.png" alt="raw">',
].join("\n");

function markdown(source: string): string {
	return renderToStaticMarkup(createElement(MessageMarkdown, { source }));
}

test("conversation Markdown admits formatting without document features", () => {
	let markup = markdown(PARTICIPANT_MESSAGE);

	expect(markup).toContain("<strong>Bold</strong>");
	expect(markup).toContain("<em>italic</em>");
	expect(markup).toContain("<ul>");
	expect(markup).toContain("<li>first</li>");
	expect(markup).toContain("<ol>");
	expect(markup).toContain("<li>one</li>");
	expect(markup).toContain("<blockquote>");
	expect(markup).toContain("quoted");
	expect(markup).toContain('href="https://example.com"');
	expect(markup).toContain('target="_blank"');
	expect(markup).toContain("<p>Use <code>bun test</code>.</p>");
	expect(markup).toContain('<code class="language-ts">let answer = 42;');
	expect(markup).toContain("Ordinary message text");
	expect(markup).not.toContain("<h1>");
	expect(markup).not.toContain("<img");

	expect(markdown("Planner wrote **strongly**.")).toContain("<strong>strongly</strong>");
});
