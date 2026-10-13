import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isRangeSelection,
} from "lexical";

import { $createDecisionNode, $createQuestionnaireNode, registry } from "@chopin/dialect";

import { $caretAfterRun } from "./deck-leave";

test("a dissolving deck places the caret in prose beyond a hidden comment decision", () => {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError: error => {
			throw error;
		},
	});
	editor.update(() => {
		let card = $createQuestionnaireNode();
		let prose = $createParagraphNode().append($createTextNode("Prose after the decisions."));
		$getRoot().append(card, $createDecisionNode(), prose);

		expect($caretAfterRun([card.getId()])).toBe(true);
		let selection = $getSelection();
		expect($isRangeSelection(selection)).toBe(true);
		if (!$isRangeSelection(selection)) throw new Error("Expected a caret in the prose.");
		expect(selection.anchor.getNode().getParent()).toBe(prose);
		expect(selection.anchor.offset).toBe(0);
		expect(selection.isCollapsed()).toBe(true);
	}, { discrete: true });
});
