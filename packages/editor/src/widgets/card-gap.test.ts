import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { $createQuestionnaireNode, registry } from "@chopin/dialect";

import { compactCardGaps } from "./card-gap";

test("card gaps retain one caret without changing prose or outer blank paragraphs", () => {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError(error) {
			throw error;
		},
	});
	let expected: string[] = [];
	editor.update(() => {
		let leading = $createParagraphNode();
		let first = $createQuestionnaireNode({ id: "first", questions: [] });
		let blanks = Array.from({ length: 3 }, () => $createParagraphNode());
		let second = $createQuestionnaireNode({ id: "second", questions: [] });
		let prose = $createParagraphNode().append($createTextNode("Keep this prose."));
		let third = $createQuestionnaireNode({ id: "third", questions: [] });
		let trailing = [$createParagraphNode(), $createParagraphNode()];
		$getRoot().append(leading, first, ...blanks, second, prose, third, ...trailing);

		blanks[1]!.select();
		compactCardGaps();
		expect($getRoot().getChildren()).toHaveLength(10);
		prose.selectEnd();
		compactCardGaps();
		expected = [leading, first, blanks[0]!, second, prose, third, ...trailing].map(node =>
			node.getKey()
		);
	}, { discrete: true });
	editor.getEditorState().read(() => {
		expect($getRoot().getChildren().map(node => node.getKey())).toEqual(expected);
	});
});
