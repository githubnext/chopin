import { describe, expect, it } from "bun:test";
import { $isLinkNode } from "@lexical/link";
import { $getRoot, $isElementNode, $isTextNode, createEditor } from "lexical";

import { $exportPlan, $importPlan, registry } from "@chopin/dialect";

import { $linkAt, $updateLink } from "./link";

import type { LinkNode } from "@lexical/link";
import type { TextNode } from "lexical";

const SOURCE = "Read [the docs](https://example.com/docs) before [starting](README.md).\n";

function open() {
	let schema = registry();
	let editor = createEditor({
		nodes: schema.nodes,
		onError: error => {
			throw error;
		},
	});
	editor.update(() => $importPlan(SOURCE, { registry: schema }), { discrete: true });
	let write = (change: () => void) => {
		editor.update(change, { discrete: true });
		return editor.getEditorState().read(() => $exportPlan({ registry: schema }));
	};
	return { editor, write };
}

function $links(): LinkNode[] {
	let paragraph = $getRoot().getFirstChild();
	return $isElementNode(paragraph) ? paragraph.getChildren().filter($isLinkNode) : [];
}

function $text(link: LinkNode | undefined): TextNode {
	let text = link?.getFirstChild();
	if (!$isTextNode(text)) throw new Error("expected the link's text");
	return text;
}

describe("the link under the selection", () => {
	it("finds the link a caret sits in", () => {
		let { editor } = open();
		let url: string | undefined;
		editor.update(() => {
			url = $linkAt($text($links()[0]).select(2, 2))?.getURL();
		}, { discrete: true });
		expect(url).toBe("https://example.com/docs");
	});

	it("finds nothing when a selection spans more than one link", () => {
		let { editor } = open();
		let url: string | undefined = "unset";
		editor.update(() => {
			let [first, second] = $links();
			let selection = $text(first).select(0, 0);
			selection.focus.set($text(second).getKey(), 3, "text");
			url = $linkAt(selection)?.getURL();
		}, { discrete: true });
		expect(url).toBeUndefined();
	});
});

describe("changing a link in place", () => {
	it("points a link somewhere else without touching its text", () => {
		let { write } = open();
		let out = write(() => $updateLink($links()[0]!.getKey(), "https://example.com/guide"));
		expect(out).toContain("[the docs](https://example.com/guide)");
	});

	it("unwraps a removed link back into plain text", () => {
		let { write } = open();
		let out = write(() => $updateLink($links()[1]!.getKey(), null));
		expect(out).toBe("Read [the docs](https://example.com/docs) before starting.\n");
	});
});
