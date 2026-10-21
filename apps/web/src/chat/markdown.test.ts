import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { inlineText } from "./inline-text";
import { InlineMarkdown, MessageMarkdown } from "./markdown";
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

test("Chat Markdown admits formatting without document features", () => {
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

test("indentation keeps nested lists and code blocks intact", () => {
	let nested =
		/<li>parent\s*<ul>\s*<li>child<\/li>\s*<li>sibling<\/li>\s*<\/ul>\s*<\/li>\s*<li>next<\/li>/;

	expect(markdown("- parent\n  - child\n  - sibling\n- next")).toMatch(nested);
	expect(markdown("- parent\n    - child\n    - sibling\n- next")).toMatch(nested);
	expect(markdown("1. parent\n   - child\n   - sibling\n2. next")).toMatch(nested);
	expect(markdown("```py\nif ready:\n    run()\n```")).toContain("if ready:\n    run()");
	expect(markdown("Ask @chopin about it")).toContain("Ask about it");
});

test("a numbered list that continues after a lead-in line still renders as a list", () => {
	let source = [
		"Can start right away:",
		"1. `prove-core`: prove it.",
		"2. `add-tests`: add the tests.",
		"",
		"Needs task 1 first:",
		"3. `rewire-handler`: rewire it.",
		"",
		"Need task 3 first:",
		"4. `table-tests`: check tables",
		"   and statuses.",
		"5. `secret-test`: check the secret.",
	].join("\n");
	let markup = markdown(source);

	expect(markup).toContain("<p>Needs task 1 first:</p>");
	expect(markup).toContain(
		'<ol start="3">\n<li><code>rewire-handler</code>: rewire it.</li>\n</ol>',
	);
	expect(markup).toContain("<p>Need task 3 first:</p>");
	expect(markup).toMatch(
		/<ol start="4">\s*<li><code>table-tests<\/code>: check tables\s+and statuses\.<\/li>\s*<li><code>secret-test<\/code>: check the secret\.<\/li>\s*<\/ol>/,
	);
	// An escaped marker, a number inside a sentence, and code stay as written.
	expect(markdown("Released in\n2024\\. Then more")).toContain(
		"<p>Released in\n2024. Then more</p>",
	);
	expect(markdown("Step\n`3. code`")).not.toContain("<ol");
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

test("historical research references remain readable without composer discovery", () => {
	let source = "See %OAuth evidence";
	let start = source.indexOf("%OAuth evidence");
	let persisted: Chat.ResearchReference = {
		id: "research-reference",
		kind: "research",
		parentChannelId: "parent-channel",
		workspaceId: "workspace-one",
		start,
		end: source.length,
		label: "%OAuth evidence",
		href: "/documents/octo-org/score/parent/research/workspace-one",
		repositoryId: "repository-one",
		observedRevision: 4,
	};

	let markup = markdown(source, [persisted]);

	expect(markup).toContain('data-chat-reference="research"');
	expect(markup).toContain(">%OAuth evidence</span>");
	expect(markup).not.toContain("<a");
	expect(markup).not.toContain("/research/");

	let documentMarkup = markdown("See #Release", [reference("See #Release", "#Release")]);
	expect(documentMarkup).toContain('data-chat-reference="document"');
	expect(documentMarkup).toContain('href="/documents/octo-org/score/reference-one"');

	let currentPercentMarkup = markdown("See %Current research");
	expect(currentPercentMarkup).toContain("See %Current research");
	expect(currentPercentMarkup).not.toContain("data-chat-reference");
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

function inline(source: string, links?: boolean): string {
	return renderToStaticMarkup(createElement(InlineMarkdown, { source, links }));
}

test("inline Markdown formats code, emphasis and links without blocks", () => {
	expect(inline("Rewire `login` to **call** _three_ [helpers](https://example.com)")).toBe(
		'Rewire <code>login</code> to <strong>call</strong> <em>three</em> <a href="https://example.com" rel="noopener noreferrer" target="_blank">helpers</a>',
	);
	// A task title sits inside a button, so its links read as text.
	expect(inline("See [the docs](https://example.com)", false)).toBe("See the docs");
	// What would open a block in a message stays the text it is.
	expect(inline("1. First")).toBe("1. First");
	expect(inline("- item")).toBe("- item");
	expect(inline("# Heading")).toBe("# Heading");
	expect(inline("> quote")).toBe("&gt; quote");
	expect(inline("    indented `code`")).toBe("indented <code>code</code>");
	expect(inline("<b>raw</b> ![image](https://example.invalid/i.png)")).toBe("raw ");
	expect(inline("one\n\ntwo")).toBe("one two");
});

test("the plain text of inline Markdown is the text it shows, with single spaces", () => {
	let sources = [
		"Rewire `login` to **call** _three_ [helpers](https://example.com)",
		"Deploy on `main`",
		"Read [the docs](https://example.com)",
		"<b>raw</b> ![image](https://example.invalid/i.png)",
		"> quote &amp; `a  b`",
		"one\n\ntwo",
	];
	for (let source of sources) {
		let shown = inline(source, false).replace(/<[^>]+>/g, "").replaceAll("&gt;", ">")
			.replaceAll("&amp;", "&");
		expect(inlineText(source)).toBe(shown.replace(/\s+/g, " ").trim());
	}
	expect(inlineText("Deploy on `main`")).toBe("Deploy on main");
	expect(inlineText("<b>raw</b> ![image](https://example.invalid/i.png)")).toBe("raw");
});
