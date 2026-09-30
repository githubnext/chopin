import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isNodeSelection,
	$isRangeSelection,
	$isTextNode,
} from "lexical";

import { $createQuestionnaireNode, registry } from "@chopin/dialect";

import { $skipHidden, skip } from "./decorator-selection";

import type { LexicalEditor } from "lexical";

test("skip steps over a run of hidden blocks and stops at the first visible one", () => {
	let blocks = ["text", "hidden", "hidden", "text", "hidden"];
	let hidden = (block: string) => block === "hidden";
	expect(skip(blocks, 0, "next", hidden)).toEqual({ at: 3 });
	expect(skip(blocks, 3, "previous", hidden)).toEqual({ at: 0 });
	// Nothing adjacent to skip, or nothing beyond it.
	expect(skip(blocks, 2, "next", hidden)).toBeUndefined();
	expect(skip(blocks, 3, "next", hidden)).toBeUndefined();
	expect(skip(blocks, 3, "previous", block => block === "x")).toBeUndefined();
});

function build(): LexicalEditor {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError(error) {
			throw error;
		},
	});
	editor.update(() => {
		let before = $createParagraphNode().append($createTextNode("Before"));
		let card = $createQuestionnaireNode({ id: "01K0N4TR8K7JGM4R1J7PW4R8YJ", questions: [] });
		$getRoot().append(before, card, $createParagraphNode().append($createTextNode("After")));
		before.selectEnd();
	}, { discrete: true });
	return editor;
}

function press(
	editor: LexicalEditor,
	direction: "next" | "previous",
	vertical: boolean,
	hidden: boolean,
) {
	let outcome: ReturnType<typeof $skipHidden>;
	editor.update(() => {
		outcome = $skipHidden(direction, vertical, () => hidden);
	}, { discrete: true });
	return outcome;
}

function caret(editor: LexicalEditor) {
	return editor.read(() => {
		let selection = $getSelection();
		if (!$isRangeSelection(selection)) return undefined;
		return { text: selection.anchor.getNode().getTextContent(), offset: selection.anchor.offset };
	});
}

test("horizontal arrows place the caret across a hidden card and never select it", () => {
	let editor = build();
	expect(press(editor, "next", false, true)).toBe("moved");
	expect(caret(editor)).toEqual({ text: "After", offset: 0 });
	expect(press(editor, "previous", false, true)).toBe("moved");
	expect(caret(editor)).toEqual({ text: "Before", offset: 6 });
});

test("vertical arrows are left to the browser, and only beside a hidden card", () => {
	let editor = build();
	expect(press(editor, "next", true, true)).toBe("native");
	expect(press(editor, "next", true, false)).toBeUndefined();
	editor.read(() => expect($isNodeSelection($getSelection())).toBe(false));
});

test("a visible card is left to Lexical, and a mid-block caret is untouched", () => {
	let editor = build();
	expect(press(editor, "next", false, false)).toBeUndefined();
	editor.update(() => {
		let text = $getRoot().getFirstChild();
		let child = $isElementNode(text) ? text.getFirstChild() : null;
		if ($isTextNode(child)) child.select(2, 2);
	}, { discrete: true });
	expect(press(editor, "next", false, true)).toBeUndefined();
	expect(caret(editor)).toEqual({ text: "Before", offset: 2 });
});
