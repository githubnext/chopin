import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { $createQuestionnaireNode, registry } from "@chopin/dialect";

import { atBlockEnd, atBlockStart } from "./discarded-navigation-boundary";

test("only the first and last inline text runs reach their block boundaries", () => {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError(error) {
			throw error;
		},
	});
	let firstRunAtStart = false;
	let laterRunAtStart = true;
	let firstRunAtEnd = true;
	let laterRunAtEnd = false;
	editor.update(() => {
		let paragraph = $createParagraphNode();
		let first = $createTextNode("visible ");
		let later = $createTextNode("formatted").toggleFormat("bold");
		paragraph.append(first, later);
		$getRoot().append(paragraph);
		firstRunAtStart = atBlockStart(first);
		laterRunAtStart = atBlockStart(later);
		firstRunAtEnd = atBlockEnd(first);
		laterRunAtEnd = atBlockEnd(later);
	}, { discrete: true });

	expect(firstRunAtStart).toBe(true);
	expect(laterRunAtStart).toBe(false);
	expect(firstRunAtEnd).toBe(false);
	expect(laterRunAtEnd).toBe(true);
});

test("a block after a discarded node still starts at its first text run", () => {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError(error) {
			throw error;
		},
	});
	let startsAtBlockBeginning = false;
	let endsAtBlockEnd = false;
	editor.update(() => {
		let before = $createParagraphNode().append($createTextNode("Before"));
		let beforeText = before.getFirstChild()!;
		let discarded = $createQuestionnaireNode({
			id: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
			questions: [],
			status: "discarded",
		});
		let firstRun = $createTextNode("After");
		let after = $createParagraphNode().append(firstRun);
		$getRoot().append(before, discarded, after);
		startsAtBlockBeginning = atBlockStart(firstRun);
		endsAtBlockEnd = atBlockEnd(beforeText);
	}, { discrete: true });

	expect(startsAtBlockBeginning).toBe(true);
	expect(endsAtBlockEnd).toBe(true);
});
