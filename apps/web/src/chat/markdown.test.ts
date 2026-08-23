import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageMarkdown } from "./markdown";
import { referenceRenderModel } from "./references";

import type { Chat } from "@chopin/protocol";

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

function reference(source: string, token: string, id = "reference-one"): Chat.Reference {
	let start = source.indexOf(token);
	return {
		id,
		kind: "document",
		channelId: `channel-${id}`,
		start,
		end: start + token.length,
		label: token,
		href: `/documents/octo-org/score/${id}`,
		repositoryId: "repository-one",
		observedRevision: 4,
		observedSourceHash: "sha256:source",
	};
}

function markdown(source: string, references?: Chat.Reference[]): string {
	return renderToStaticMarkup(createElement(MessageMarkdown, { source, references }));
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

test("authoritative ranges render internal chips inside ordinary Markdown", () => {
	let source = "@chopin Read **#Release: v2 (API)** and [the docs](https://example.com).";
	let markup = markdown(source, [reference(source, "#Release: v2 (API)")]);

	expect(markup).not.toContain("@chopin");
	expect(markup).toContain(
		'<strong><a class="chat-reference" data-chat-reference="document" href="/documents/octo-org/score/reference-one">#Release: v2 (API)</a></strong>',
	);
	expect(markup).toContain('href="https://example.com"');
	expect(markup).toContain('rel="noopener noreferrer"');
	expect(markup).toContain('target="_blank"');
	expect(markup).not.toMatch(/class="chat-reference"[^>]*target=/);
});

test("the range, rather than title punctuation or duplicate labels, builds chip slots", () => {
	let source = "See #A[]() and #A[]().";
	let first = reference(source, "#A[]()", "first");
	let secondStart = source.lastIndexOf("#A[]()");
	let second = {
		...reference(source, "#A[]()", "second"),
		start: secondStart,
		end: secondStart + 6,
	};
	let model = referenceRenderModel(source, [second, first]);

	expect(model.references.map(item => item.id)).toEqual(["first", "second"]);
	expect(markdown(source, [second, first]).match(/class="chat-reference"/g)).toHaveLength(2);
});

test("chips preserve the server label and href rather than reparsing token text", () => {
	let source = "See #Old title";
	let persisted = {
		...reference(source, "#Old title"),
		label: "#Release plan (captured)",
		href: "/documents/octo-org/score/release-at-send-time",
	};
	let markup = markdown(source, [persisted]);

	expect(markup).toContain(">#Release plan (captured)</a>");
	expect(markup).toContain('href="/documents/octo-org/score/release-at-send-time"');
});

test("user-authored and encoded links cannot imitate a typed reference node", () => {
	let source = "[ordinary](chopin-reference:0) [encoded](chopin-reference%3A0) and #Plan";
	let markup = markdown(source, [reference(source, "#Plan")]);

	expect(markup.match(/class="chat-reference"/g)).toHaveLength(1);
	expect(markup).toContain(">ordinary</a>");
	expect(markup).toContain(">encoded</a>");
	expect(markup).toContain(">#Plan</a>");
});

test("encoded marker text cannot satisfy an authoritative source range", () => {
	let source = "&#35;Plan and #Real";
	let real = reference(source, "#Real", "real");
	let encoded = { ...real, id: "encoded", start: 0, end: "&#35;Plan".length };
	let markup = markdown(source, [encoded, real]);

	expect(markup).not.toContain("data-chat-reference");
	expect(markup).toContain("#Plan and ");
	expect(markup).toContain("#Real");
});

test("ranges inside code, link labels, and link destinations remain ordinary text", () => {
	let source = "`#Code` [#Label](https://example.com) [destination](#Target) and #Plan";
	let references = [
		reference(source, "#Code", "code"),
		reference(source, "#Label", "label"),
		reference(source, "#Target", "target"),
		reference(source, "#Plan", "plan"),
	];
	let markup = markdown(source, references);

	expect(markup.match(/class="chat-reference"/g)).toHaveLength(1);
	expect(markup).toContain("<code>#Code</code>");
	expect(markup).toContain(">#Label</a>");
	expect(markup).toContain('href="#Target"');
	expect(markup).toContain(">#Plan</a>");
});

test("display projection protects mentions inside authoritative labels", () => {
	let source = "@chopin See #Ask @chopin and @sam";
	let markup = markdown(source, [reference(source, "#Ask @chopin")]);

	expect(markup).not.toMatch(/^.*@chopin See/);
	expect(markup).toContain(">#Ask @chopin</a>");
	expect(markup).toContain("and Sam");
});

test("invalid and overlapping ranges remain safe ordinary text", () => {
	let source = "See #Alpha and #Beta";
	let alpha = reference(source, "#Alpha", "alpha");
	let overlap = { ...alpha, id: "overlap" };
	let invalid = { ...reference(source, "#Beta", "invalid"), end: source.length + 10 };
	let markup = markdown(source, [alpha, overlap, invalid]);

	expect(markup).not.toContain("data-chat-reference");
	expect(markup).toContain("See #Alpha and #Beta");
});
