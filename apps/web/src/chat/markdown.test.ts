import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RepositoryLinksProvider } from "@chopin/editor";

import { inlineText } from "./inline-text";
import { MarkdownText } from "../markdown-text/markdown-text";
import { InlineMarkdown, MessageMarkdown, sameMessageMarkdown } from "./markdown";
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

/** An h1 start tag with or without attributes: MarkdownText's elements carry an aui-md class. */
const H1 = /<h1(?:\s|>)/;

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

	expect(markup).toContain('<strong class="aui-md-strong">Bold</strong>');
	expect(markup).toContain("<em>italic</em>");
	expect(markup).toContain('<ul class="aui-md-ul">');
	expect(markup).toContain('<li class="aui-md-li">first</li>');
	expect(markup).toContain('<ol class="aui-md-ol">');
	expect(markup).toContain('<li class="aui-md-li">one</li>');
	expect(markup).toContain('<blockquote class="aui-md-blockquote">');
	expect(markup).toContain("quoted");
	expect(markup).toContain('href="https://example.com"');
	expect(markup).toContain('target="_blank"');
	expect(markup).toContain(
		'<p class="aui-md-p">Use <code class="aui-md-inline-code">bun test</code>.</p>',
	);
	expect(markup).toContain('<code class="language-ts">let answer = 42;');
	expect(markup).toContain("Ordinary message text");
	expect(markup).not.toMatch(H1);
	expect(markup).not.toContain("<img");

	expect(markdown("Planner wrote **strongly**.")).toContain(
		'<strong class="aui-md-strong">strongly</strong>',
	);
});

test("the check that Chat draws no h1 recognises an h1 that carries a class", () => {
	let drawn = renderToStaticMarkup(createElement(MarkdownText, { text: "# Title" }));
	// MarkdownText draws a heading as an h1 with its class, which "<h1>" alone would never match.
	expect(drawn).toContain('<h1 class="aui-md-h1">Title</h1>');
	expect(drawn).not.toContain("<h1>");
	expect(drawn).toMatch(H1);
	expect(H1.test("<h1>")).toBe(true);
	// Chat's message draws the same source as a line of text.
	expect(markdown("# Title")).not.toMatch(H1);
	expect(markdown("# Title")).toContain('<p class="aui-md-p">Title</p>');
});

test("Chat reads GitHub's tables, strikethrough and task lists, and only those", () => {
	let markup = markdown(
		"| A | B |\n| - | - |\n| 1 | 2 |\n\n~~gone~~ and ~one~ and about ~5 minutes, ~10 at most\n\n- [x] done\n- [ ] open",
	);
	expect(markup).toContain('<table class="aui-md-table">');
	expect(markup).toContain("<del>gone</del>");
	// One tilde is not strikethrough: it is the text a person typed.
	expect(markup).toContain("~one~ and about ~5 minutes, ~10 at most");
	expect(markup.match(/<input [^>]*type="checkbox"/g)).toHaveLength(2);
	// A box is named, so a reader of the screen hears what it is before the item's words.
	expect(markup.match(/<input aria-label="Task"/g)).toHaveLength(2);
	expect(markup).toContain('<li class="aui-md-li task-list-item">');
});

test("a footnote, a bare address and a www link stay the plain text they were in Chat", () => {
	let markup = markdown(
		"Claim[^1] and see https://example.com/page, www.example.com or ana@example.com.\n\n[^1]: The note.",
	);
	expect(markup).not.toContain("<a");
	expect(markup).not.toContain("<sup");
	expect(markup).not.toContain("<section");
	expect(markup).not.toContain("footnote");
	expect(markup).toContain(
		"Claim[^1] and see https://example.com/page, www.example.com or ana@example.com.",
	);
	expect(markup).toContain("[^1]: The note.");
	// A link someone wrote is still a link.
	expect(markdown("[the page](https://example.com/page)")).toContain(
		'href="https://example.com/page"',
	);
});

test("indentation keeps nested lists and code blocks intact", () => {
	let nested =
		/<li class="aui-md-li">parent\s*<ul class="aui-md-ul">\s*<li class="aui-md-li">child<\/li>\s*<li class="aui-md-li">sibling<\/li>\s*<\/ul>\s*<\/li>\s*<li class="aui-md-li">next<\/li>/;

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

	expect(markup).toContain('<p class="aui-md-p">Needs task 1 first:</p>');
	expect(markup).toContain(
		'<ol class="aui-md-ol" start="3">\n<li class="aui-md-li"><code class="aui-md-inline-code">rewire-handler</code>: rewire it.</li>\n</ol>',
	);
	expect(markup).toContain('<p class="aui-md-p">Need task 3 first:</p>');
	expect(markup).toMatch(
		/<ol class="aui-md-ol" start="4">\s*<li class="aui-md-li"><code class="aui-md-inline-code">table-tests<\/code>: check tables\s+and statuses\.<\/li>\s*<li class="aui-md-li"><code class="aui-md-inline-code">secret-test<\/code>: check the secret\.<\/li>\s*<\/ol>/,
	);
	// An escaped marker, a number inside a sentence, and code stay as written.
	expect(markdown("Released in\n2024\\. Then more")).toContain(
		'<p class="aui-md-p">Released in\n2024. Then more</p>',
	);
	expect(markdown("Step\n`3. code`")).not.toContain("<ol");
});

test("authoritative ranges render internal chips inside ordinary Markdown", () => {
	let source = "@chopin Read **#Release: v2 (API)** and [the docs](https://example.com).";
	let markup = markdown(source, [reference(source, "#Release: v2 (API)")]);

	expect(markup).not.toContain("@chopin");
	expect(markup).toContain(
		'<strong class="aui-md-strong"><a class="chat-reference" data-chat-reference="document" href="/documents/octo-org/score/reference-one">#Release: v2 (API)</a></strong>',
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

test("a command that opened a message is a chip, not a link, and the words after it are its own", () => {
	let source = "/skill:release-notes for **v2**";
	let command: Chat.CommandReference = {
		id: "command-reference",
		kind: "command",
		start: 0,
		end: "/skill:release-notes".length,
		label: "/skill:release-notes",
		name: "skill:release-notes",
		commandKind: "skill",
	};
	let markup = markdown(source, [command]);

	expect(markup).toContain(
		'<span class="chat-reference" data-chat-reference="command">/skill:release-notes</span>',
	);
	expect(markup).toContain('<strong class="aui-md-strong">v2</strong>');
	expect(markup).not.toContain("<a");
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
	expect(markup).toContain('<code class="aui-md-inline-code">#Code</code>');
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
		'Rewire <code class="aui-md-inline-code">login</code> to <strong class="aui-md-strong">call</strong> <em>three</em> <a class="aui-md-a" href="https://example.com" rel="noopener noreferrer" target="_blank">helpers</a>',
	);
	// A task title sits inside a button, so its links read as text.
	expect(inline("See [the docs](https://example.com)", false)).toBe("See the docs");
	// What would open a block in a message stays the text it is.
	expect(inline("1. First")).toBe("1. First");
	expect(inline("- item")).toBe("- item");
	expect(inline("# Heading")).toBe("# Heading");
	expect(inline("> quote")).toBe("&gt; quote");
	expect(inline("    indented `code`")).toBe(
		'indented <code class="aui-md-inline-code">code</code>',
	);
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

const REPOSITORY = { owner: "octo-org", name: "score", ref: "main" };
const BLOB = "https://github.com/octo-org/score/blob/main";

function inRepository(element: ReturnType<typeof createElement>): string {
	return renderToStaticMarkup(
		createElement(RepositoryLinksProvider, { value: REPOSITORY }, element),
	);
}

test("a repository path in Chat opens the file on GitHub, as it does in the document", () => {
	let source = "See [the review](docs/review.md#L10-L20) and [the app](./src/app.ts).";
	let markup = inRepository(createElement(MessageMarkdown, { source }));

	expect(markup).toContain(
		`<a class="aui-md-a" href="${BLOB}/docs/review.md#L10-L20" rel="noopener noreferrer" target="_blank">the review</a>`,
	);
	expect(markup).toContain(`<a class="aui-md-a" href="${BLOB}/src/app.ts"`);
	expect(
		inRepository(createElement(InlineMarkdown, { source: "Edit [the app](src/app.ts)" })),
	).toContain(`<a class="aui-md-a" href="${BLOB}/src/app.ts"`);
});

test("every other link in Chat is as written, with or without a repository", () => {
	let source =
		"[web](https://example.com/a) [mail](mailto:ana@example.com) [here](#here) [out](../secrets.md) [gone](//evil.example/a)";
	let elsewhere = markdown(source);
	let inside = inRepository(createElement(MessageMarkdown, { source }));

	for (let href of ["https://example.com/a", "mailto:ana@example.com", "#here", "../secrets.md"]) {
		expect(inside).toContain(`href="${href}"`);
		expect(elsewhere).toContain(`href="${href}"`);
	}
	expect(inside).not.toContain("github.com");
	// Without a repository to resolve against, a path stays the path it was.
	expect(markdown("See [the review](docs/review.md)")).toContain('href="docs/review.md"');
});

test("a message's Markdown is drawn again only when what it says changes", () => {
	let reference = {
		kind: "document" as const,
		id: "ref-1",
		start: 4,
		end: 9,
		label: "The plan",
		href: "/documents/octo-org/score/plan",
		repositoryId: "R_1",
		observedRevision: 3,
		channelId: "c1",
		observedSourceHash: "abc",
	};
	let props = { className: "body", mention: "@chopin", references: [reference], source: "See it" };
	// A message to the Planner hands over its references as a new list on every render.
	expect(sameMessageMarkdown(props, { ...props, references: [{ ...reference }] })).toBe(true);
	expect(sameMessageMarkdown({ source: "Same" }, { source: "Same" })).toBe(true);

	expect(sameMessageMarkdown(props, { ...props, source: "See it again" })).toBe(false);
	expect(sameMessageMarkdown(props, { ...props, mention: undefined })).toBe(false);
	expect(sameMessageMarkdown(props, { ...props, className: "other" })).toBe(false);
	expect(sameMessageMarkdown(props, { ...props, references: [{ ...reference, end: 10 }] })).toBe(
		false,
	);
	expect(sameMessageMarkdown(props, { ...props, references: undefined })).toBe(false);
	expect(sameMessageMarkdown(props, { ...props, references: [] })).toBe(false);
});

test("a message is drawn again when it starts or stops streaming, and not when its flag is only absent", () => {
	let base = { source: "Same" };
	expect(sameMessageMarkdown({ ...base, streaming: true }, { ...base, streaming: false })).toBe(
		false,
	);
	expect(sameMessageMarkdown({ ...base, streaming: false }, { ...base, streaming: true })).toBe(
		false,
	);
	expect(sameMessageMarkdown({ ...base, streaming: undefined }, { ...base, streaming: true })).toBe(
		false,
	);
	expect(sameMessageMarkdown({ ...base, streaming: true }, { ...base, streaming: undefined })).toBe(
		false,
	);
	// Absent and false both mean the message is settled.
	expect(sameMessageMarkdown({ ...base, streaming: undefined }, { ...base, streaming: false }))
		.toBe(true);
	expect(sameMessageMarkdown({ ...base, streaming: false }, base)).toBe(true);
	expect(sameMessageMarkdown({ ...base, streaming: true }, { ...base, streaming: true })).toBe(
		true,
	);
	// Streaming shows as the root's status.
	expect(renderToStaticMarkup(createElement(MessageMarkdown, { ...base, streaming: true })))
		.toContain(
			'data-status="running"',
		);
	expect(renderToStaticMarkup(createElement(MessageMarkdown, base))).toContain(
		'data-status="complete"',
	);
});
