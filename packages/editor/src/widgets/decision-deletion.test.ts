import { expect, spyOn, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $createHeadingNode } from "@lexical/rich-text";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isRangeSelection,
	DELETE_CHARACTER_COMMAND,
} from "lexical";
import { $createQuestionnaireNode, registry } from "@chopin/dialect";
import { QuestionnaireStore } from "../questionnaires";
import { registerDocumentTitle } from "../document-title";
import { $isAdjacentDecisionProse, registerDecisionDeletion } from "./decision-deletion";

for (let target of ["prose", "missing", "unrelated", "title"] as const) {
	test(`decided-card deletion ${target === "prose" ? "reaches" : "refuses"} the ${target} target across empty caret paragraphs`, () => {
		let editor = createHeadlessEditor({
			nodes: registry().nodes,
			onError: error => {
				throw error;
			},
		});
		let questions = new QuestionnaireStore();
		let proseKey = "";
		let followingKey = "";
		let titleKey = "";
		editor.update(() => {
			let title = $createHeadingNode("h1").append($createTextNode("Title"));
			let prose = $createParagraphNode().append($createTextNode("Decided prose."));
			let following = $createParagraphNode().append($createTextNode("Following detail."));
			titleKey = title.getKey();
			proseKey = prose.getKey();
			followingKey = following.getFirstChild()!.getKey();
			$getRoot().append(title, prose);
			if (target === "unrelated") {
				$getRoot().append($createParagraphNode().append($createTextNode("Unrelated prose.")));
			}
			$getRoot().append(
				$createParagraphNode(),
				$createParagraphNode(),
				$createQuestionnaireNode({ id: "decided", questions: [], status: "decided" }),
				following,
			);
			following.selectStart();
		}, { discrete: true });
		let resolve = spyOn(questions, "proseKey").mockReturnValue(
			target === "missing" ? undefined : target === "title" ? titleKey : proseKey,
		);
		registerDocumentTitle(editor);
		registerDecisionDeletion(editor, undefined, questions);
		let before = editor.read(() => $getRoot().getChildren().map(node => node.getKey()));
		editor.update(() => {
			expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
		}, { discrete: true });
		editor.read(() => {
			let selection = $getSelection();
			expect($isRangeSelection(selection)).toBe(true);
			if (!$isRangeSelection(selection)) throw new Error("missing caret");
			expect(selection.anchor.getNode().getTextContent()).toBe(
				target === "prose" ? "Decided prose." : "Following detail.",
			);
			expect(selection.anchor.offset).toBe(target === "prose" ? 14 : 0);
			if (target !== "prose") expect(selection.anchor.key).toBe(followingKey);
			expect($getRoot().getChildren().map(node => node.getKey())).toEqual(before);
		});
		resolve.mockRestore();
	});
}

for (let target of ["prose", "linked", "missing", "unrelated", "title", "separated"] as const) {
	test(`generic decided-card merging ${target === "prose" || target === "linked" ? "accepts" : "refuses"} an adjacent ${target} target`, () => {
		let editor = createHeadlessEditor({
			nodes: registry().nodes,
			onError: error => {
				throw error;
			},
		});
		let questions = new QuestionnaireStore();
		let key = "";
		editor.update(() => {
			let heading = $createHeadingNode("h1").append($createTextNode("Title"));
			let prose = $createParagraphNode().append($createTextNode("Decided prose."));
			$getRoot().append(heading);
			key = target === "title" ? heading.getKey() : prose.getKey();
			if (target !== "title") $getRoot().append(prose);
			if (target === "unrelated") {
				$getRoot().append($createParagraphNode().append($createTextNode("Unrelated prose.")));
			}
			if (target === "separated") $getRoot().append($createParagraphNode());
			$getRoot().append($createQuestionnaireNode({
				id: "decided",
				status: "decided",
				questions: [{
					id: "question",
					header: "Choose",
					prompt: "Choose",
					multiple: false,
					options: [{ id: "option", label: "Choice" }],
				}],
			}));
		}, { discrete: true });
		let prose = spyOn(questions, "proseKey").mockReturnValue(
			target === "missing" || target === "linked" ? undefined : key,
		);
		let links = spyOn(questions, "blocks").mockImplementation((widget, question) =>
			target === "linked" && widget === "decided" && question === "question" ? [key] : []
		);
		editor.read(() => {
			expect($isAdjacentDecisionProse($getRoot().getLastChild()!, questions)).toBe(
				target === "prose" || target === "linked",
			);
		});
		prose.mockRestore();
		links.mockRestore();
	});
}
