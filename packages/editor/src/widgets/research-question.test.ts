import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { $createResearchQuestionNode, $isResearchQuestionNode, registry } from "@chopin/dialect";

import { normalizeResearchQuestionIds } from "./research-question";

const EXISTING = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const DISTINCT = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";

test("clipboard research questions keep moves and remint conflicts", () => {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError(error) {
			throw error;
		},
	});
	let ids: string[] = [];
	editor.update(() => {
		$getRoot().append(
			$createResearchQuestionNode(EXISTING).append(
				$createParagraphNode().append($createTextNode("Existing")),
			),
		);
		let conflict = $createResearchQuestionNode(EXISTING);
		let distinct = $createResearchQuestionNode(DISTINCT);
		let invalid = $createResearchQuestionNode("");
		normalizeResearchQuestionIds([conflict, distinct, invalid]);
		let moved = $createResearchQuestionNode(DISTINCT);
		normalizeResearchQuestionIds([moved], new Set([DISTINCT]));
		ids = [conflict, distinct, invalid, moved].map(node =>
			$isResearchQuestionNode(node) ? node.getId() : ""
		);
	}, { discrete: true });

	expect(ids[0]).not.toBe(EXISTING);
	expect(ids[1]).not.toBe(DISTINCT);
	expect(ids[2]).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
	expect(ids[3]).toBe(DISTINCT);
	expect(new Set(ids).size).toBe(4);
});
