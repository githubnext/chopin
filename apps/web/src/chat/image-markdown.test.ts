import { expect, test } from "bun:test";

import { imagesOutOfLinksRemarkPlugin } from "./image-markdown";

type Node = {
	type: string;
	alt?: string;
	identifier?: string;
	title?: string | null;
	url?: string;
	value?: string;
	children?: Node[];
};

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

test("a link with words and pictures keeps its words, and the words and pictures stay in the order written", () => {
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
		{ type: "link", url: "https://example.com", children: [{ type: "text", value: "docs" }] },
		image("b", "b.png"),
	]);
});

test("a picture between a link's words leaves the words on each side a link, and the picture between them", () => {
	let tree = lifted({
		type: "paragraph",
		children: [{
			type: "link",
			url: "https://example.com/t",
			children: [{ type: "text", value: "Before " }, image("d", "u.png"), {
				type: "text",
				value: " after",
			}],
		}],
	});

	expect(tree.children).toEqual([
		{ type: "link", url: "https://example.com/t", children: [{ type: "text", value: "Before " }] },
		image("d", "u.png"),
		{ type: "link", url: "https://example.com/t", children: [{ type: "text", value: " after" }] },
	]);
});

test("a picture inside emphasis in a link, or in a link written as a reference, comes out of it, and the formatting stays around the words", () => {
	let nested = lifted({
		type: "paragraph",
		children: [{
			type: "link",
			url: "https://example.com/t",
			children: [{
				type: "strong",
				children: [{ type: "text", value: "Before " }, image("d", "u.png"), {
					type: "text",
					value: " after",
				}],
			}],
		}],
	});
	expect(nested.children).toEqual([
		{
			type: "link",
			url: "https://example.com/t",
			children: [{ type: "strong", children: [{ type: "text", value: "Before " }] }],
		},
		image("d", "u.png"),
		{
			type: "link",
			url: "https://example.com/t",
			children: [{ type: "strong", children: [{ type: "text", value: " after" }] }],
		},
	]);

	let only = lifted({
		type: "paragraph",
		children: [{
			type: "linkReference",
			identifier: "target",
			children: [{ type: "emphasis", children: [image("pic", "u.png")] }],
		}],
	});
	expect(only.children).toEqual([
		image("pic", "u.png"),
		{ type: "linkReference", identifier: "target", children: [{ type: "text", value: "pic" }] },
	]);
});

test("a picture written as a reference is a picture to lift out of a link, as the definition says", () => {
	let tree = lifted({
		type: "root",
		children: [
			{
				type: "paragraph",
				children: [{
					type: "link",
					url: "https://example.com/t",
					children: [{ type: "imageReference", identifier: "ref", alt: "pic" }],
				}],
			},
			{ type: "definition", identifier: "REF", url: "u.png", title: "Title" },
		],
	});

	expect(tree.children![0]!.children).toEqual([
		{ type: "image", alt: "pic", url: "u.png", title: "Title" },
		{ type: "link", url: "https://example.com/t", children: [{ type: "text", value: "pic" }] },
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
