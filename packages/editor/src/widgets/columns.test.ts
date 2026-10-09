import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, $getSelection, $isElementNode, $isRangeSelection } from "lexical";

import { $isColumnsNode, exportPlan, importPlan, registry } from "@chopin/dialect";

import { $unwrapColumns } from "./columns";

test("unwrap keeps blocks and the caret in source order", () => {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError(error) {
			throw error;
		},
	});
	importPlan(
		editor,
		`<Columns id="01K0N4W3B7P27CBAEC7A8C8WEA">\n`
			+ `<Column id="01K0N4W3B7P27CBAEC7A8C8WEB">\n\nFirst.\n\nNext.\n\n</Column>\n`
			+ `<Column id="01K0N4W3B7P27CBAEC7A8C8WEC">\n\nLast.\n\n</Column>\n`
			+ `</Columns>\n`,
	);
	let selectedKey = "";
	editor.update(() => {
		let columns = $getRoot().getFirstChild();
		if (!$isColumnsNode(columns)) throw new Error("Expected columns");
		let second = columns.getLastChild();
		let last = $isElementNode(second) ? second.getLastDescendant() : null;
		last?.selectEnd();
		let selection = $getSelection();
		selectedKey = $isRangeSelection(selection) ? selection.anchor.key : "";
		$unwrapColumns(columns);
	}, { discrete: true });
	expect(exportPlan(editor)).toBe("First.\n\nNext.\n\nLast.\n");
	editor.getEditorState().read(() => {
		expect($getRoot().getChildren().map(node => node.getType())).toEqual([
			"paragraph",
			"paragraph",
			"paragraph",
		]);
		let selection = $getSelection();
		expect($isRangeSelection(selection) && selection.anchor.key).toBe(selectedKey);
	});
});
