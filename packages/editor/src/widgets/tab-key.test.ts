import { describe, expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createListItemNode, $createListNode } from "@lexical/list";
import { $createHeadingNode } from "@lexical/rich-text";
import {
	$createLineBreakNode,
	$createParagraphNode,
	$createTabNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isRangeSelection,
} from "lexical";

import { $createCodeBlockNode, registry } from "@chopin/dialect";

import { $tabContext, $untab, leadingIndent, tabAction } from "./tab-key";

import type { LexicalEditor, TextNode } from "lexical";
import type { CodeBlockNode } from "@chopin/dialect";
import type { TabContext } from "./tab-key";

const REGISTRY = registry();

function editor(): LexicalEditor {
	return createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(error) {
			throw error;
		},
	});
}

describe("tabAction", () => {
	let list = (nest: boolean, unnest: boolean): TabContext => ({ place: "list", nest, unnest });

	test("nests and un-nests list items that can move", () => {
		expect(tabAction(list(true, true), false)).toBe("indent");
		expect(tabAction(list(true, true), true)).toBe("outdent");
	});

	test("leaves a list item that cannot move", () => {
		expect(tabAction(list(false, true), false)).toBe("leave");
		expect(tabAction(list(true, false), true)).toBe("leave");
	});

	test("indents and outdents code lines", () => {
		expect(tabAction({ place: "code" }, false)).toBe("tab");
		expect(tabAction({ place: "code" }, true)).toBe("untab");
	});

	test("leaves code when Escape came first", () => {
		expect(tabAction({ place: "code" }, false, true)).toBe("leave");
		expect(tabAction({ place: "code" }, true, true)).toBe("leave");
	});

	test("hands the key to the browser everywhere else", () => {
		expect(tabAction({ place: "prose" }, false)).toBe("leave");
		expect(tabAction({ place: "prose" }, true)).toBe("leave");
	});
});

describe("leadingIndent", () => {
	test("finds a tab or up to four spaces at the start of the caret's line", () => {
		expect(leadingIndent("a\n\tb", 4)).toEqual({ start: 2, length: 1 });
		expect(leadingIndent("a\n      b", 5)).toEqual({ start: 2, length: 4 });
		expect(leadingIndent("  b", 0)).toEqual({ start: 0, length: 2 });
	});

	test("finds nothing on a line that is not indented", () => {
		expect(leadingIndent("\tA\nb", 4)).toBeNull();
		expect(leadingIndent("", 0)).toBeNull();
	});
});

describe("$tabContext", () => {
	function context(build: () => { start: TextNode; end?: TextNode }) {
		let result = null as TabContext | null;
		editor().update(() => {
			let { start, end } = build();
			let selection = start.select(1, 1);
			if (end) selection.focus.set(end.getKey(), 1, "text");
			result = $tabContext();
		}, { discrete: true });
		return result;
	}

	let item = (text: TextNode) => $createListItemNode().append(text);

	test("reads a heading as prose", () => {
		expect(context(() => {
			let text = $createTextNode("Title");
			$getRoot().append($createHeadingNode("h1").append(text));
			return { start: text };
		})).toEqual({ place: "prose" });
	});

	test("cannot nest the first item or un-nest a top-level one", () => {
		expect(context(() => {
			let one = $createTextNode("one");
			$getRoot().append($createListNode("bullet").append(item(one), item($createTextNode("two"))));
			return { start: one };
		})).toEqual({ place: "list", nest: false, unnest: false });
	});

	test("nests an item under the one before it", () => {
		expect(context(() => {
			let two = $createTextNode("two");
			$getRoot().append($createListNode("bullet").append(item($createTextNode("one")), item(two)));
			return { start: two };
		})).toEqual({ place: "list", nest: true, unnest: false });
	});

	test("un-nests a nested item, but cannot nest it again with nothing above it", () => {
		expect(context(() => {
			let two = $createTextNode("two");
			$getRoot().append(
				$createListNode("bullet").append(
					item($createTextNode("one")),
					$createListItemNode().append($createListNode("bullet").append(item(two))),
				),
			);
			return { start: two };
		})).toEqual({ place: "list", nest: false, unnest: true });
	});

	test("cannot nest a selection that includes the first item", () => {
		expect(context(() => {
			let one = $createTextNode("one");
			let two = $createTextNode("two");
			$getRoot().append($createListNode("bullet").append(item(one), item(two)));
			return { start: one, end: two };
		})).toEqual({ place: "list", nest: false, unnest: false });
	});

	test("reads a code block as code", () => {
		expect(context(() => {
			let code = $createCodeBlockNode("ts", "let a = 1;");
			$getRoot().append(code);
			return { start: code.getFirstChild() as TextNode };
		})).toEqual({ place: "code" });
	});

	test("reads a selection from a list into a paragraph as prose", () => {
		expect(context(() => {
			let one = $createTextNode("one");
			let after = $createTextNode("after");
			$getRoot().append(
				$createListNode("bullet").append(item($createTextNode("zero")), item(one)),
				$createParagraphNode().append(after),
			);
			return { start: one, end: after };
		})).toEqual({ place: "prose" });
	});
});

describe("$untab", () => {
	function untab(build: () => { code: CodeBlockNode; caret: () => void }) {
		let lexical = editor();
		let out = { text: "", offset: -1 };
		lexical.update(() => {
			let { code, caret } = build();
			caret();
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) throw new Error("no selection");
			$untab(code, selection);
			out.text = code.getTextContent();
		}, { discrete: true });
		lexical.getEditorState().read(() => {
			let selection = $getSelection();
			if ($isRangeSelection(selection)) out.offset = selection.anchor.offset;
		});
		return out;
	}

	test("removes a tab node opening the caret's line", () => {
		let result = untab(() => {
			let code = $createCodeBlockNode("ts");
			let body = $createTextNode("b();");
			code.append($createTextNode("a();"), $createLineBreakNode(), $createTabNode(), body);
			$getRoot().append(code);
			return { code, caret: () => body.select(2, 2) };
		});
		expect(result.text).toBe("a();\nb();");
		expect(result.offset).toBe(2);
	});

	test("removes leading spaces from imported text", () => {
		let result = untab(() => {
			let code = $createCodeBlockNode("ts", "a();\n    b();");
			$getRoot().append(code);
			let text = code.getFirstChild() as TextNode;
			return { code, caret: () => text.select(11, 11) };
		});
		expect(result.text).toBe("a();\nb();");
		expect(result.offset).toBe(7);
	});

	test("does nothing on a line without an indent", () => {
		let result = untab(() => {
			let code = $createCodeBlockNode("ts", "\ta();\nb();");
			$getRoot().append(code);
			let text = code.getFirstChild() as TextNode;
			return { code, caret: () => text.select(8, 8) };
		});
		expect(result.text).toBe("\ta();\nb();");
		expect(result.offset).toBe(8);
	});
});
