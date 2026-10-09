import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot, $isElementNode } from "lexical";

import {
	$createCalloutNode,
	$createColumnNode,
	$createColumnsNode,
	$isColumnNode,
	registry,
} from "@chopin/dialect";

import { handleEnter } from "./enter";

import type { LexicalEditor } from "lexical";

const REGISTRY = registry();

function enter(editor: LexicalEditor): boolean {
	let handled = false;
	editor.update(() => {
		handled = handleEnter();
	}, { discrete: true });
	return handled;
}

function tree(editor: LexicalEditor) {
	return editor.getEditorState().read(() =>
		$getRoot().getChildren().map(node => ({
			type: node.getType(),
			children: $isElementNode(node)
				? node.getChildren().map(child => ({ type: child.getType(), text: child.getTextContent() }))
				: [],
		}))
	);
}

test("enter repairs and leaves a callout stored with direct text", () => {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(error) {
			throw error;
		},
	});

	// This tree projects to valid source and survived in Yjs checkpoints created
	// by the old slash command, even though current callouts contain paragraphs.
	editor.update(() => {
		let text = $createTextNode("Legacy body.");
		$getRoot().append(
			$createCalloutNode("01K0N4W3B7P27CBAEC7A8C8WEA").append(text),
		);
		text.selectEnd();
	}, { discrete: true });

	expect(enter(editor)).toBe(true);
	expect(tree(editor)).toEqual([{
		type: "plan-callout",
		children: [
			{ type: "paragraph", text: "Legacy body." },
			{ type: "paragraph", text: "" },
		],
	}]);

	expect(enter(editor)).toBe(true);
	expect(tree(editor)).toEqual([
		{
			type: "plan-callout",
			children: [{ type: "paragraph", text: "Legacy body." }],
		},
		{ type: "paragraph", children: [] },
	]);
});

test("enter leaves the final empty paragraph in the second column", () => {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(error) {
			throw error;
		},
	});
	let firstEmpty = "";
	let secondEmpty = "";
	editor.update(() => {
		let first = $createColumnNode("01K0N4W3B7P27CBAEC7A8C8WEB");
		let second = $createColumnNode("01K0N4W3B7P27CBAEC7A8C8WEC");
		first.append($createParagraphNode().append($createTextNode("First.")));
		first.append($createParagraphNode());
		second.append($createParagraphNode().append($createTextNode("Second.")));
		second.append($createParagraphNode());
		$getRoot().append($createColumnsNode("01K0N4W3B7P27CBAEC7A8C8WEA").append(first, second));
		firstEmpty = first.getLastChildOrThrow().getKey();
		secondEmpty = second.getLastChildOrThrow().getKey();
	}, { discrete: true });

	editor.update(() => {
		let first = $getRoot().getFirstChild();
		let column = $isElementNode(first) ? first.getFirstChild() : null;
		let paragraph = $isColumnNode(column) ? column.getLastChild() : null;
		if ($isElementNode(paragraph)) paragraph.select();
	}, { discrete: true });
	expect(enter(editor)).toBe(false);
	expect(tree(editor)).toHaveLength(1);

	editor.update(() => {
		let columns = $getRoot().getFirstChild();
		let column = $isElementNode(columns) ? columns.getLastChild() : null;
		let paragraph = $isColumnNode(column) ? column.getLastChild() : null;
		if ($isElementNode(paragraph)) paragraph.select();
	}, { discrete: true });
	expect(enter(editor)).toBe(true);
	expect(tree(editor).map(node => node.type)).toEqual(["plan-columns", "paragraph"]);
	editor.getEditorState().read(() => {
		let columns = $getRoot().getFirstChild();
		let first = $isElementNode(columns) ? columns.getFirstChild() : null;
		let second = $isElementNode(columns) ? columns.getLastChild() : null;
		expect($isColumnNode(first) && first.getLastChild()?.getKey()).toBe(firstEmpty);
		expect($isColumnNode(second) && second.getLastChild()?.getKey()).not.toBe(secondEmpty);
		expect($isColumnNode(first) && first.getChildrenSize()).toBe(2);
		expect($isColumnNode(second) && second.getChildrenSize()).toBe(1);
	});
});
