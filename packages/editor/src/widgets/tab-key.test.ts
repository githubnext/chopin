import { describe, expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createListItemNode, $createListNode } from "@lexical/list";
import { $createHeadingNode } from "@lexical/rich-text";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";

import { $createCodeBlockNode, registry } from "@chopin/dialect";

import { $tabPlace, tabAction } from "./tab-key";

import type { TextNode } from "lexical";
import type { TabPlace } from "./tab-key";

const REGISTRY = registry();

describe("tabAction", () => {
	test("nests and un-nests list items", () => {
		expect(tabAction("list", false)).toBe("indent");
		expect(tabAction("list", true)).toBe("outdent");
	});

	test("types a tab in code, and lets Shift+Tab leave", () => {
		expect(tabAction("code", false)).toBe("tab");
		expect(tabAction("code", true)).toBe("leave");
	});

	test("hands the key to the browser everywhere else", () => {
		expect(tabAction("prose", false)).toBe("leave");
		expect(tabAction("prose", true)).toBe("leave");
	});
});

describe("$tabPlace", () => {
	function place(build: () => { start: TextNode; end?: TextNode }) {
		let editor = createHeadlessEditor({
			nodes: REGISTRY.nodes,
			onError(error) {
				throw error;
			},
		});
		let result = null as TabPlace | null;
		editor.update(() => {
			let { start, end } = build();
			let selection = start.select(1, 1);
			if (end) selection.focus.set(end.getKey(), 1, "text");
			result = $tabPlace();
		}, { discrete: true });
		return result;
	}

	test("reads a heading or paragraph as prose", () => {
		expect(place(() => {
			let text = $createTextNode("Title");
			$getRoot().append($createHeadingNode("h1").append(text));
			return { start: text };
		})).toBe("prose");
	});

	test("reads anywhere in a list item as a list", () => {
		expect(place(() => {
			let text = $createTextNode("item");
			$getRoot().append($createListNode("bullet").append($createListItemNode().append(text)));
			return { start: text };
		})).toBe("list");
	});

	test("reads a code block as code", () => {
		expect(place(() => {
			let code = $createCodeBlockNode("ts", "let a = 1;");
			$getRoot().append(code);
			return { start: code.getFirstChild() as TextNode };
		})).toBe("code");
	});

	test("reads a selection from a list into a paragraph as prose", () => {
		expect(place(() => {
			let item = $createTextNode("item");
			let after = $createTextNode("after");
			$getRoot().append(
				$createListNode("bullet").append($createListItemNode().append(item)),
				$createParagraphNode().append(after),
			);
			return { start: item, end: after };
		})).toBe("prose");
	});
});
