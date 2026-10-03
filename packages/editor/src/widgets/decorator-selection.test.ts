import { expect, spyOn, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createNodeSelection,
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isNodeSelection,
	$isRangeSelection,
	$isTextNode,
	$setSelection,
} from "lexical";

import { $createQuestionnaireNode, registry } from "@chopin/dialect";

import {
	$deleteAcross,
	$releaseHidden,
	$skipHidden,
	registerDecoratorSelection,
	skip,
} from "./decorator-selection";

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

function types(editor: LexicalEditor): string[] {
	return editor.read(() => $getRoot().getChildren().map(node => node.getType()));
}

test("Backspace at the start of the block after a hidden card joins the paragraphs around it", () => {
	let editor = build();
	editor.update(() => {
		let after = $getRoot().getLastChild();
		if ($isElementNode(after)) after.selectStart();
	}, { discrete: true });
	editor.update(() => {
		expect($deleteAcross("previous", () => true)).toBe(true);
	}, { discrete: true });
	expect(types(editor)).toEqual(["paragraph", "plan-questionnaire"]);
	expect(editor.read(() => $getRoot().getFirstChild()?.getTextContent())).toBe("BeforeAfter");
	// The caret is at the join, inside the merged text.
	expect(caret(editor)).toEqual({ text: "BeforeAfter", offset: 6 });
});

test("Delete at the end of the block before a hidden card joins the next paragraph", () => {
	let editor = build();
	editor.update(() => {
		expect($deleteAcross("next", () => true)).toBe(true);
	}, { discrete: true });
	expect(types(editor)).toEqual(["paragraph", "plan-questionnaire"]);
	expect(editor.read(() => $getRoot().getFirstChild()?.getTextContent())).toBe("BeforeAfter");
});

test("a visible card is left to Lexical for Backspace and Delete", () => {
	let editor = build();
	editor.update(() => {
		expect($deleteAcross("next", () => false)).toBe(false);
	}, { discrete: true });
	expect(types(editor)).toEqual(["paragraph", "plan-questionnaire", "paragraph"]);
});

test("a hidden card in a node selection is handed on to the next text block", () => {
	let editor = build();
	editor.update(() => {
		let card = $getRoot().getChildren()[1]!;
		let nodes = $createNodeSelection();
		nodes.add(card.getKey());
		$setSelection(nodes);
		expect($releaseHidden("next", () => true)).toBe(true);
	}, { discrete: true });
	expect(caret(editor)).toEqual({ text: "After", offset: 0 });
	editor.update(() => {
		let card = $getRoot().getChildren()[1]!;
		let nodes = $createNodeSelection();
		nodes.add(card.getKey());
		$setSelection(nodes);
		// A visible card is never released.
		expect($releaseHidden("next", () => false)).toBe(false);
	}, { discrete: true });
});

test("an unresolved node selection does not schedule a hidden-card correction", async () => {
	let editor = build();
	let unregister = registerDecoratorSelection(editor, () => false);
	let updates = spyOn(editor, "update");
	try {
		editor.update(() => {
			let selection = $createNodeSelection();
			selection.add("missing-decorator");
			$setSelection(selection);
			expect(selection.has("missing-decorator")).toBe(true);
			expect(selection.getNodes()).toEqual([]);
			expect($releaseHidden("next", () => false)).toBe(false);
			expect($getSelection()).toBe(selection);
		}, { discrete: true });
		await Promise.resolve();
		editor.read(() => {
			let selection = $getSelection();
			expect($isNodeSelection(selection)).toBe(true);
			if (!$isNodeSelection(selection)) throw new Error("Expected the unresolved selection");
			expect(selection.has("missing-decorator")).toBe(true);
			expect(selection.getNodes()).toEqual([]);
		});
		let corrections = updates.mock.calls.filter(([, options]) => options?.tag === "history-merge");
		expect(corrections).toHaveLength(0);
	} finally {
		unregister();
		updates.mockRestore();
	}
});
