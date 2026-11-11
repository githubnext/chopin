import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RepositoryLinksProvider } from "@chopin/editor";

import { defaultComponents, MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { markdownClass } from "./assistant-ui/markdown-classes.test-fixtures";
import { inlineText } from "./inline-text";
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
].join("\n");

/** Raw HTML is never drawn, whatever it holds. */
let RAW_HTML_MESSAGE = [
	"# Ordinary message text",
	"",
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

const P_CLASS = markdownClass("p");
const STRONG_CLASS = markdownClass("strong");
const A_CLASS = markdownClass("a");
const CODE_CLASS = markdownClass("code");
const UL_CLASS = markdownClass("ul");
const OL_CLASS = markdownClass("ol");
const LI_CLASS = markdownClass("li");
const QUOTE_CLASS = markdownClass("blockquote");
const TABLE_CLASS = /^<div[^>]*><table class="([^"]+)"/.exec(
	renderToStaticMarkup(createElement(defaultComponents.table!)),
)![1]!;

function markdown(source: string, references?: Chat.Reference[]): string {
	return renderToStaticMarkup(createElement(MessageMarkdown, { source, references }));
}

test("Chat Markdown admits formatting without document features", () => {
	let markup = markdown(PARTICIPANT_MESSAGE);

	expect(markup).toContain(`<strong class="${STRONG_CLASS}">Bold</strong>`);
	expect(markup).toContain("<em>italic</em>");
	expect(markup).toContain(`<ul class="${UL_CLASS}">`);
	expect(markup).toContain(`<li class="${LI_CLASS}">first</li>`);
	expect(markup).toContain(`<ol class="${OL_CLASS}">`);
	expect(markup).toContain(`<li class="${LI_CLASS}">one</li>`);
	expect(markup).toContain(`<blockquote class="${QUOTE_CLASS}">`);
	expect(markup).toContain("quoted");
	expect(markup).toContain('href="https://example.com"');
	expect(markup).toContain('target="_blank"');
	expect(markup).toContain(
		`<p class="${P_CLASS}">Use <code class="${CODE_CLASS}">bun test</code>.</p>`,
	);
	expect(markup).toContain('<code class="language-ts">let answer = 42;');
	expect(markup).toContain("Ordinary message text");
	expect(markup).not.toMatch(H1);
	expect(markup).toContain(
		'<img alt="remote" class="chat-image-preview" decoding="async" loading="lazy" referrerPolicy="no-referrer" src="https://example.invalid/pixel.png"/>',
	);
	expect(markup).toContain('<span aria-hidden="true" class="chat-image-alt">remote</span>');

	expect(markdown("Planner wrote **strongly**.")).toContain(
		`<strong class="${STRONG_CLASS}">strongly</strong>`,
	);
});

test("the check that Chat draws no h1 recognises an h1 that carries a class", () => {
	let drawn = renderToStaticMarkup(createElement(MarkdownText, { text: "# Title" }));
	// MarkdownText draws a heading as an h1 with its class, which "<h1>" alone would never match.
	expect(drawn).toContain(
		'<h1 class="aui-md-h1 mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0">Title</h1>',
	);
	expect(drawn).not.toContain("<h1>");
	expect(drawn).toMatch(H1);
	expect(H1.test("<h1>")).toBe(true);
	// Chat's message draws the same source as a line of text.
	expect(markdown("# Title")).not.toMatch(H1);
	expect(markdown("# Title")).toContain(`<p class="${P_CLASS}">Title</p>`);
});

test("Chat reads GitHub's tables, strikethrough and task lists, and only those", () => {
	let markup = markdown(
		"| A | B |\n| - | - |\n| 1 | 2 |\n\n~~gone~~ and ~one~ and about ~5 minutes, ~10 at most\n\n- [x] done\n- [ ] open",
	);
	expect(markup).toContain(`<table class="${TABLE_CLASS}">`);
	expect(markup).toContain("<del>gone</del>");
	// One tilde is not strikethrough: it is the text a person typed.
	expect(markup).toContain("~one~ and about ~5 minutes, ~10 at most");
	expect(markup.match(/<input [^>]*type="checkbox"/g)).toHaveLength(2);
	// A box is named, so a reader of the screen hears what it is before the item's words.
	expect(markup.match(/<input aria-label="Task"/g)).toHaveLength(2);
	expect(markup).toContain(`<li class="${LI_CLASS} task-list-item">`);
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

test("raw HTML in a Chat message is never drawn, an image tag included", () => {
	let markup = markdown(RAW_HTML_MESSAGE);

	expect(markup).toContain("Ordinary message text");
	expect(markup).not.toContain("<h1>");
	expect(markup).not.toContain("<img");
});

test("every Markdown image draws where it is written, in order, and none is merged or dropped", () => {
	let markup = markdown(
		"First ![one](https://example.invalid/a.png) then ![two](https://example.invalid/a.png)\n\n![](https://example.invalid/b.png)",
	);

	expect(markup.match(/<img /g)).toHaveLength(3);
	expect(markup.indexOf('alt="one"')).toBeLessThan(markup.indexOf('alt="two"'));
	expect(markup.indexOf('alt="two"')).toBeLessThan(markup.indexOf('alt="Image"'));
	expect(markup).not.toMatch(/<p[\s>][^]*<figure/);
	expect(markup).toContain('<div class="chat-markdown-paragraph">First <figure');
	expect(markup).toContain('<span aria-hidden="true" class="chat-image-alt">Image</span>');
});

function tiles(markup: string): string[] {
	return [...markup.matchAll(/ alt="([^"]*)" class="chat-image-preview"[^>]* src="([^"]*)"/g)].map(
		found => `${found[1]}|${found[2]}`,
	);
}

test("images written side by side in one paragraph are one compact gallery, in the order they were written", () => {
	for (
		let separator of [" ", "  ", "\n", " \n ", "  \n", "\\\n"]
	) {
		let markup = markdown(
			`![One](https://example.invalid/1.png)${separator}![Two](https://example.invalid/2.png)${separator}![Three](https://example.invalid/3.png)`,
		);
		let name = JSON.stringify(separator);
		expect(markup.match(/data-chat-image-gallery/g), name).toHaveLength(1);
		expect(markup.match(/data-chat-image="tile"/g), name).toHaveLength(3);
		expect(markup, name).not.toContain('data-chat-image="single"');
		expect(tiles(markup), name).toEqual([
			"One|https://example.invalid/1.png",
			"Two|https://example.invalid/2.png",
			"Three|https://example.invalid/3.png",
		]);
		for (let alt of ["One", "Two", "Three"]) {
			expect(markup, name).toContain(
				`<span aria-hidden="true" class="chat-image-alt">${alt}</span>`,
			);
		}
	}
});

test("images in consecutive paragraphs of their own are one gallery, and a paragraph of several is part of it", () => {
	let markup = markdown(
		"![One](https://example.invalid/1.png)\n\n![Two](https://example.invalid/2.png) ![Three](https://example.invalid/3.png)\n\n![Four](https://example.invalid/4.png)",
	);

	expect(markup.match(/data-chat-image-gallery/g)).toHaveLength(1);
	expect(tiles(markup).map(item => item.split("|")[0])).toEqual(["One", "Two", "Three", "Four"]);
	expect(markup).not.toContain('data-chat-image="single"');
});

test("the words around a gallery stay where they were written, and the images are not moved", () => {
	let markup = markdown(
		"Before ![One](https://example.invalid/1.png) ![Two](https://example.invalid/2.png) after.\n\nNext paragraph.",
	);

	expect(markup.match(/data-chat-image-gallery/g)).toHaveLength(1);
	expect(markup).toContain(
		'<div class="chat-markdown-paragraph">Before <div class="chat-image-gallery"',
	);
	expect(markup.indexOf("Before")).toBeLessThan(markup.indexOf("data-chat-image-gallery"));
	expect(markup.indexOf("data-chat-image-gallery")).toBeLessThan(markup.indexOf(" after."));
	expect(markup.indexOf(" after.")).toBeLessThan(markup.indexOf('<p class="aui-md-p">Next paragraph.</p>'));
	expect(markup).not.toMatch(/<p[\s>][^]*<div class="chat-image-gallery/);
});

test("images with words or a paragraph of words between them are not made a gallery", () => {
	for (
		let source of [
			"![One](https://example.invalid/1.png) and ![Two](https://example.invalid/2.png)",
			"![One](https://example.invalid/1.png)\n\nBetween.\n\n![Two](https://example.invalid/2.png)",
			"![One](https://example.invalid/1.png) *Between* ![Two](https://example.invalid/2.png)",
			"Words ![One](https://example.invalid/1.png)\n\n![Two](https://example.invalid/2.png)",
			"- ![One](https://example.invalid/1.png)\n- ![Two](https://example.invalid/2.png)",
		]
	) {
		let markup = markdown(source);
		expect(markup, source).not.toContain("data-chat-image-gallery");
		expect(markup.match(/data-chat-image="single"/g), source).toHaveLength(2);
		expect(tiles(markup).map(item => item.split("|")[0]), source).toEqual(["One", "Two"]);
	}
});

test("a gallery keeps a repeated image, an image without alt text and the reason one cannot be shown", () => {
	let markup = markdown(
		"![Same](https://example.invalid/a.png) ![Same](https://example.invalid/a.png) ![](https://example.invalid/b.png) ![nope](javascript:alert(1)) ![svg](data:image/svg+xml;base64,PHN2Zy8+)",
	);

	expect(markup.match(/data-chat-image-gallery/g)).toHaveLength(1);
	expect(markup.match(/data-chat-image="tile"/g)).toHaveLength(5);
	expect(tiles(markup)).toEqual([
		"Same|https://example.invalid/a.png",
		"Same|https://example.invalid/a.png",
		"Image|https://example.invalid/b.png",
	]);
	expect(markup.match(/data-chat-image-broken="unavailable"/g)).toHaveLength(2);
	expect(markup).toContain('<span aria-hidden="true" class="chat-image-alt">nope</span>');
	expect(markup).toContain('<span aria-hidden="true" class="chat-image-alt">svg</span>');
	expect(markup).not.toContain("javascript:");
	expect(markup).not.toContain("svg+xml");
});

test("every image written together keeps its own tile however many there are, and raw HTML between them is still never drawn", () => {
	let markup = markdown(
		`${
			Array.from({ length: 8 }, (_, index) =>
				`![Pic ${index + 1}](https://example.invalid/${index + 1}.png)`)
				.join(" ")
		}\n\n<img src="https://example.invalid/raw.png" alt="raw">`,
	);

	expect(markup.match(/data-chat-image-gallery/g)).toHaveLength(1);
	expect(markup.match(/data-chat-image="tile"/g)).toHaveLength(8);
	expect(tiles(markup).map(item => item.split("|")[0])).toEqual(
		Array.from({ length: 8 }, (_, index) => `Pic ${index + 1}`),
	);
	expect(markup).not.toContain("chat-image-more");
	expect(markup).not.toContain("raw.png");
});

test("images lifted out of one link, or written in a list item or a quotation, are grouped where they are", () => {
	let linked = markdown(
		"[![One](https://example.invalid/1.png) ![Two](https://example.invalid/2.png)](https://example.com)",
	);
	expect(linked.match(/data-chat-image-gallery/g)).toHaveLength(1);
	expect(linked).toContain('href="https://example.com"');
	expect(linked).not.toMatch(/<a [^>]*>[^]*<figure/);

	for (
		let source of [
			"- ![One](https://example.invalid/1.png) ![Two](https://example.invalid/2.png)",
			"> ![One](https://example.invalid/1.png)\n>\n> ![Two](https://example.invalid/2.png)",
		]
	) {
		let markup = markdown(source);
		expect(markup.match(/data-chat-image-gallery/g), source).toHaveLength(1);
		expect(markup.match(/data-chat-image="tile"/g), source).toHaveLength(2);
	}
});

function insideLink(markup: string): boolean {
	return /<a [^>]*>(?:(?!<\/a>)[^])*<figure/.test(markup);
}

test("images written as references are a gallery with the ones written in line, in the order written, wherever their definitions are", () => {
	for (
		let source of [
			"![One][a] ![Two][b] ![Three](https://example.invalid/3.png)\n\n[a]: https://example.invalid/1.png\n[b]: https://example.invalid/2.png",
			"[a]: https://example.invalid/1.png\n\n![One][a] ![Two][B]\n![Three][]\n\n[b]: https://example.invalid/2.png\n[three]: https://example.invalid/3.png",
			"![One][a]\n\n[a]: https://example.invalid/1.png\n\n![Two][b]\n\n[b]: https://example.invalid/2.png\n\n![Three](https://example.invalid/3.png)",
			"![One](https://example.invalid/1.png) ![Two][b] ![Three][three]\n\n[b]: https://example.invalid/2.png\n[three]: https://example.invalid/3.png",
		]
	) {
		let markup = markdown(source);
		expect(markup.match(/data-chat-image-gallery/g), source).toHaveLength(1);
		expect(markup.match(/data-chat-image="tile"/g), source).toHaveLength(3);
		expect(markup, source).not.toContain('data-chat-image="single"');
		expect(tiles(markup), source).toEqual([
			"One|https://example.invalid/1.png",
			"Two|https://example.invalid/2.png",
			"Three|https://example.invalid/3.png",
		]);
	}
});

test("a reference image is the image its first definition says, as a single or in a gallery, and one with no definition stays the words it was", () => {
	let alone = markdown(
		"![One][a]\n\n[a]: https://example.invalid/first.png\n[a]: https://example.invalid/second.png",
	);
	expect(tiles(alone)).toEqual(["One|https://example.invalid/first.png"]);
	expect(alone).toContain('data-chat-image="single"');

	let unsafe = markdown(
		"![Fine][a] ![Nope][bad]\n\n[a]: https://example.invalid/1.png\n[bad]: javascript:alert(1)",
	);
	expect(unsafe.match(/data-chat-image="tile"/g)).toHaveLength(2);
	expect(unsafe).toContain('data-chat-image-broken="unavailable"');
	expect(unsafe).not.toContain("javascript:");

	let missing = markdown("![One][a] ![Two][nothing]\n\n[a]: https://example.invalid/1.png");
	expect(missing).not.toContain("data-chat-image-gallery");
	expect(tiles(missing)).toEqual(["One|https://example.invalid/1.png"]);
	expect(missing).toContain("![Two][nothing]");
});

test("an image inside a link is drawn where it was written among the link's words, and never inside the link", () => {
	let between = markdown(
		"[Before ![d](https://example.invalid/u.png) after](https://example.com/t)",
	);
	expect(insideLink(between)).toBe(false);
	expect(between.indexOf(">Before ")).toBeLessThan(between.indexOf("<figure"));
	expect(between.indexOf("<figure")).toBeLessThan(between.indexOf("> after<"));
	expect(between.match(/<a class="aui-md-a" href="https:\/\/example.com\/t"/g)).toHaveLength(2);
	expect(between).toContain('target="_blank">Before </a>');
	expect(between).toContain('target="_blank"> after</a>');

	let nested = markdown(
		"[**Before ![d](https://example.invalid/u.png) after**](https://example.com/t)",
	);
	expect(insideLink(nested)).toBe(false);
	expect(nested).toContain('<strong class="aui-md-strong">Before </strong></a>');
	expect(nested).toContain('<strong class="aui-md-strong"> after</strong></a>');
	expect(nested.indexOf("Before")).toBeLessThan(nested.indexOf("<figure"));
	expect(nested.indexOf("<figure")).toBeLessThan(nested.indexOf("after"));
});

test("an image alone in emphasis in a link, or in a link written as a reference, is drawn outside it, and the link keeps its words", () => {
	for (
		let source of [
			"[**![logo](https://example.invalid/l.png)**](https://example.com/t)",
			"[*![logo](https://example.invalid/l.png)*](https://example.com/t)",
			"[![logo](https://example.invalid/l.png)][target]\n\n[target]: https://example.com/t",
			"[![logo][img]][target]\n\n[img]: https://example.invalid/l.png\n[target]: https://example.com/t",
		]
	) {
		let markup = markdown(source);
		expect(insideLink(markup), source).toBe(false);
		expect(markup.match(/<figure/g), source).toHaveLength(1);
		expect(markup, source).toContain('<img alt="logo"');
		expect(markup, source).toContain(
			'<a class="aui-md-a" href="https://example.com/t" rel="noopener noreferrer" target="_blank">logo</a>',
		);
	}
});

test("a link containing only an empty-alt image is named by its title or destination", () => {
	for (
		let [source, href, name] of [
			[
				'[![](https://example.invalid/i.png)](https://docs.example.com/guide?q=1#top "Guide title")',
				"https://docs.example.com/guide?q=1#top",
				"Guide title",
			],
			[
				"[![](https://example.invalid/i.png)](https://docs.example.com/guide?q=1#top)",
				"https://docs.example.com/guide?q=1#top",
				"docs.example.com/guide",
			],
			[
				'[![](https://example.invalid/i.png)][ref]\n\n[ref]: https://docs.example.com/guide?q=1#top "Reference title"',
				"https://docs.example.com/guide?q=1#top",
				"Reference title",
			],
			[
				"[![](https://example.invalid/i.png)][ref]\n\n[ref]: https://docs.example.com/guide?q=1#top",
				"https://docs.example.com/guide?q=1#top",
				"docs.example.com/guide",
			],
			["[![](https://example.invalid/i.png)](/docs/guide?q=1)", "/docs/guide?q=1", "/docs/guide"],
			["[![](https://example.invalid/i.png)]()", "", "Current page"],
			[
				"[![ ](https://example.invalid/i.png)](https://docs.example.com/guide)",
				"https://docs.example.com/guide",
				"docs.example.com/guide",
			],
		] as const
	) {
		let markup = markdown(source);
		expect(insideLink(markup), source).toBe(false);
		expect(markup, source).toContain(`href="${href.replaceAll("&", "&amp;")}"`);
		expect(markup, source).toContain(`aria-label="${name}"`);
	}
});

test("a Markdown image's title is its caption, as a single image and as a tile", () => {
	let single = markdown('![alt text](https://example.invalid/u.png "The title of it")');
	expect(single).toContain('<span class="chat-image-text">The title of it</span>');

	let gallery = markdown(
		'![One](https://example.invalid/1.png "First caption") ![Two](https://example.invalid/2.png) ![Three][c]\n\n[c]: https://example.invalid/3.png "Third caption"',
	);
	expect(gallery.match(/data-chat-image="tile"/g)).toHaveLength(3);
	expect([...gallery.matchAll(/chat-image-text">([^<]*)</g)].map(found => found[1])).toEqual([
		"First caption",
		"Third caption",
	]);
	expect(markdown("![alt](https://example.invalid/u.png)")).not.toContain("chat-image-text");
});

test("an image whose address is not one Chat loads shows its alt text and is never requested", () => {
	for (
		let src of [
			"/auth/logout",
			"javascript:alert(1)",
			"data:image/svg+xml;base64,PHN2Zy8+",
			"data:text/html;base64,PGI+",
		]
	) {
		let markup = markdown(`![where it was](${src})`);
		expect(markup, src).not.toContain("<img");
		expect(markup, src).toContain('data-chat-image-broken="unavailable"');
		expect(markup, src).toContain(">where it was</span>");
	}
	expect(markdown(`![mine](/images/${"a".repeat(64)}.png)`)).not.toContain("<img");
});

test("an image on this site that is not an upload waits to be read, and is never handed to the browser's own request", () => {
	for (let src of ["/icons/icon-192.png", "icons/icon-192.png", "./a.png", "/authors/a.png"]) {
		let markup = markdown(`![on this site](${src})`);
		expect(markup, src).not.toContain("<img");
		expect(markup, src).not.toContain(src);
		expect(markup, src).toContain('data-load="loading"');
		expect(markup, src).toContain('data-chat-image="single"');
		expect(markup, src).not.toContain("data-chat-image-broken");
		expect(markup, src).toContain(">on this site</span>");
	}
});

test("a raster image written into a message is drawn as written, whatever raster format it is", () => {
	for (
		let src of [
			"data:image/png;base64,iVBORw0KGgo=",
			"data:image/avif;base64,AAAAHGZ0eXBhdmlm",
			"data:image/bmp;base64,Qk0=",
			"data:image/x-icon;base64,AAABAAEA",
		]
	) {
		let markup = markdown(`![a dot](${src})`);
		expect(markup, src).toContain(
			`<img alt="a dot" class="chat-image-preview" decoding="async" loading="lazy" referrerPolicy="no-referrer" src="${src}"/>`,
		);
	}
});

test("a raster image whose type is followed by a space or a tab in an angle-bracketed address is drawn as Markdown encoded it, and SVG or HTML written the same way is not", () => {
	for (
		let [written, src] of [
			["data:image/png ;base64,iVBORw0KGgo=", "data:image/png%20;base64,iVBORw0KGgo="],
			["data:image/png\t;base64,iVBORw0KGgo=", "data:image/png%09;base64,iVBORw0KGgo="],
			["DATA:IMAGE/PNG  ;BASE64,iVBORw0KGgo=", "DATA:IMAGE/PNG%20%20;BASE64,iVBORw0KGgo="],
		]
	) {
		let markup = markdown(`![a dot](<${written}>)`);
		expect(markup, written).toContain(
			`<img alt="a dot" class="chat-image-preview" decoding="async" loading="lazy" referrerPolicy="no-referrer" src="${src}"/>`,
		);
	}
	for (
		let written of [
			"data:image/svg+xml ;base64,PHN2Zy8+",
			"data:image/svg+xml\t;base64,PHN2Zy8+",
			"data:text/html ;base64,PGI+",
			"data:image/png x;base64,iVBORw0KGgo=",
		]
	) {
		let markup = markdown(`![where it was](<${written}>)`);
		expect(markup, written).not.toContain("<img");
		expect(markup, written).toContain('data-chat-image-broken="unavailable"');
		expect(markup, written).toContain(">where it was</span>");
	}
});

test("a raster image written with white space before its type, or with no type, is drawn as Markdown made the address, and SVG or HTML written the same way is not", () => {
	let png = "iVBORw0KGgo=";
	for (
		let [written, src] of [
			[`data: image/png;base64,${png}`, `data:%20image/png;base64,${png}`],
			[`data:\timage/png ;base64,${png}`, `data:%09image/png%20;base64,${png}`],
			[`data:;base64,${png}`, `data:;base64,${png}`],
			[`data:;charset=utf-8;base64,${png}`, `data:;charset=utf-8;base64,${png}`],
			[`data: ;base64,${png}`, `data:%20;base64,${png}`],
			["data:,%89PNG%0D%0A%1A%0A", "data:,%89PNG%0D%0A%1A%0A"],
		]
	) {
		let markup = markdown(`![a dot](<${written}>)`);
		expect(markup, written).toContain(
			`<img alt="a dot" class="chat-image-preview" decoding="async" loading="lazy" referrerPolicy="no-referrer" src="${src}"/>`,
		);
	}
	let svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
	for (
		let written of [
			"data: image/svg+xml;base64,PHN2Zy8+",
			"data:\timage/svg+xml;base64,PHN2Zy8+",
			"data: text/html;base64,PGI+",
			`data:;base64,${svg.toString("base64")}`,
			`data:,${encodeURIComponent(svg.toString())}`,
			"data:;base64,AAAA",
			"data:,",
		]
	) {
		let markup = markdown(`![where it was](<${written}>)`);
		expect(markup, written).not.toContain("<img");
		expect(markup, written).toContain('data-chat-image-broken="unavailable"');
		expect(markup, written).toContain(">where it was</span>");
	}
});

test("a raster image with no type and much white space before its base64 is drawn as Markdown made the address, and SVG or HTML written the same way is not", () => {
	let png = "iVBORw0KGgo=";
	for (let spaces of [90, 300, 5_000]) {
		let markup = markdown(`![a dot](<data:;base64,${" ".repeat(spaces)}${png}>)`);
		expect(markup, `${spaces}`).toContain(
			`<img alt="a dot" class="chat-image-preview" decoding="async" loading="lazy" referrerPolicy="no-referrer" src="data:;base64,${
				"%20".repeat(spaces)
			}${png}"/>`,
		);
	}
	let svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString(
		"base64",
	);
	let html = Buffer.from("<html><body onload=alert(1)>").toString("base64");
	for (let written of [`${svg}`, `${html}`, "", "AAAA"]) {
		let markup = markdown(`![where it was](<data:;base64,${" ".repeat(300)}${written}>)`);
		expect(markup, written).not.toContain("<img");
		expect(markup, written).toContain('data-chat-image-broken="unavailable"');
		expect(markup, written).toContain(">where it was</span>");
	}
});

test("an address on another site is drawn exactly as it was written", () => {
	for (let src of ["https://example.invalid", "//example.invalid/a.png"]) {
		expect(markdown(`![far](${src})`), src).toContain(`src="${src}"/>`);
	}
});

test("an image inside a link is drawn as an image, with the link kept beside it", () => {
	let markup = markdown("[![logo](https://example.invalid/l.png)](https://example.com)");

	expect(markup).toContain('<img alt="logo"');
	expect(markup).not.toMatch(/<a [^>]*>[^]*<figure/);
	expect(markup).toContain(
		'<a class="aui-md-a" href="https://example.com" rel="noopener noreferrer" target="_blank">logo</a>',
	);
});

test("indentation keeps nested lists and code blocks intact", () => {
	let nested = new RegExp(
		`<li class="${LI_CLASS}">parent\\s*<ul class="${
			RegExp.escape(UL_CLASS)
		}">\\s*<li class="${LI_CLASS}">child<\\/li>\\s*<li class="${LI_CLASS}">sibling<\\/li>\\s*<\\/ul>\\s*<\\/li>\\s*<li class="${LI_CLASS}">next<\\/li>`,
	);

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

	expect(markup).toContain(`<p class="${P_CLASS}">Needs task 1 first:</p>`);
	expect(markup).toContain(
		`<ol class="${OL_CLASS}" start="3">\n<li class="${LI_CLASS}"><code class="${CODE_CLASS}">rewire-handler</code>: rewire it.</li>\n</ol>`,
	);
	expect(markup).toContain(`<p class="${P_CLASS}">Need task 3 first:</p>`);
	expect(markup).toMatch(
		new RegExp(
			`<ol class="${RegExp.escape(OL_CLASS)}" start="4">\\s*<li class="${LI_CLASS}"><code class="${
				RegExp.escape(CODE_CLASS)
			}">table-tests<\\/code>: check tables\\s+and statuses\\.<\\/li>\\s*<li class="${LI_CLASS}"><code class="${
				RegExp.escape(CODE_CLASS)
			}">secret-test<\\/code>: check the secret\\.<\\/li>\\s*<\\/ol>`,
		),
	);
	// An escaped marker, a number inside a sentence, and code stay as written.
	expect(markdown("Released in\n2024\\. Then more")).toContain(
		`<p class="${P_CLASS}">Released in\n2024. Then more</p>`,
	);
	expect(markdown("Step\n`3. code`")).not.toContain("<ol");
});

test("authoritative ranges render internal chips inside ordinary Markdown", () => {
	let source = "@chopin Read **#Release: v2 (API)** and [the docs](https://example.com).";
	let markup = markdown(source, [reference(source, "#Release: v2 (API)")]);

	expect(markup).not.toContain("@chopin");
	expect(markup).toContain(
		`<strong class="${STRONG_CLASS}"><a class="chat-reference" data-chat-reference="document" data-chopin-control="" href="/documents/octo-org/score/reference-one">#Release: v2 (API)</a></strong>`,
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
	expect(markup).toContain(`<strong class="${STRONG_CLASS}">v2</strong>`);
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
	expect(markup).toContain(`<code class="${CODE_CLASS}">#Code</code>`);
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
		`Rewire <code class="${CODE_CLASS}">login</code> to <strong class="${STRONG_CLASS}">call</strong> <em>three</em> <a class="${A_CLASS}" href="https://example.com" rel="noopener noreferrer" target="_blank">helpers</a>`,
	);
	// A task title sits inside a button, so its links read as text.
	expect(inline("See [the docs](https://example.com)", false)).toBe("See the docs");
	// What would open a block in a message stays the text it is.
	expect(inline("1. First")).toBe("1. First");
	expect(inline("- item")).toBe("- item");
	expect(inline("# Heading")).toBe("# Heading");
	expect(inline("> quote")).toBe("&gt; quote");
	expect(inline("    indented `code`")).toBe(
		`indented <code class="${CODE_CLASS}">code</code>`,
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
		`<a class="${A_CLASS}" href="${BLOB}/docs/review.md#L10-L20" rel="noopener noreferrer" target="_blank">the review</a>`,
	);
	expect(markup).toContain(`<a class="${A_CLASS}" href="${BLOB}/src/app.ts"`);
	expect(
		inRepository(createElement(InlineMarkdown, { source: "Edit [the app](src/app.ts)" })),
	).toContain(`<a class="${A_CLASS}" href="${BLOB}/src/app.ts"`);
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
