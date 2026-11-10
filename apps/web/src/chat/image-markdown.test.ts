import { expect, test } from "bun:test";

import { imagesOutOfLinksRemarkPlugin } from "./image-markdown";

type Node = { type: string; alt?: string; url?: string; value?: string; children?: Node[] };

function lifted(tree: Node): Node {
	imagesOutOfLinksRemarkPlugin()(tree);
	return tree;
}

const image = (alt: string, url: string): Node => ({ type: "image", alt, url });

test("an image alone in a link comes out in front of it, and the link keeps its words", () => {
	let tree = lifted({
		type: "paragraph",
		children: [{ type: "link", url: "https://example.com", children: [image("logo", "a.png")] }],
	});

	expect(tree.children).toEqual([
		image("logo", "a.png"),
		{ type: "link", url: "https://example.com", children: [{ type: "text", value: "logo" }] },
	]);
});

test("a link with words and pictures keeps its words, and the pictures keep their order", () => {
	let tree = lifted({
		type: "paragraph",
		children: [{
			type: "link",
			url: "https://example.com",
			children: [image("a", "a.png"), { type: "text", value: "docs" }, image("b", "b.png")],
		}],
	});

	expect(tree.children).toEqual([
		image("a", "a.png"),
		image("b", "b.png"),
		{ type: "link", url: "https://example.com", children: [{ type: "text", value: "docs" }] },
	]);
});

test("a picture with no alt text leaves its link's address as the link's words, and other nodes stay", () => {
	let text: Node = { type: "text", value: "plain" };
	let tree = lifted({
		type: "root",
		children: [{
			type: "paragraph",
			children: [text, {
				type: "link",
				url: "https://example.com",
				children: [image("", "a.png")],
			}],
		}],
	});

	let [paragraph] = tree.children!;
	expect(paragraph!.children![0]).toBe(text);
	expect(paragraph!.children!.at(-1)!.children).toEqual([{
		type: "text",
		value: "https://example.com",
	}]);
});
