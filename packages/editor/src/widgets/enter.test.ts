import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createTextNode, $getRoot, $isElementNode } from "lexical";

import { $createCalloutNode, registry } from "@chopin/dialect";

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
