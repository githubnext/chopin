import { expect, test } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createListItemNode,
	$createListNode,
	$insertList,
	INSERT_ORDERED_LIST_COMMAND,
	INSERT_UNORDERED_LIST_COMMAND,
	registerList,
} from "@lexical/list";
import { $createHeadingNode, $isHeadingNode } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	COLLABORATION_TAG,
	COMMAND_PRIORITY_LOW,
	CONTROLLED_TEXT_INSERTION_COMMAND,
	DELETE_CHARACTER_COMMAND,
	INSERT_PARAGRAPH_COMMAND,
	REMOVE_TEXT_COMMAND,
} from "lexical";
import { $createQuestionnaireNode, registry } from "@chopin/dialect";
import { registerDocumentTitle } from "./document-title";
import { collectPlanState } from "./questionnaires";
import { registerDecisionDeletion } from "./widgets/decision-deletion";
import { availableCommands } from "./toolbar/slash";

import type { LexicalEditor } from "lexical";

function fixture(source = "Title", protect = true) {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError: error => {
			throw error;
		},
	});
	let key = "";
	editor.update(() => {
		let title = $createHeadingNode("h1").append($createTextNode(source));
		key = title.getKey();
		$getRoot().append(title, $createParagraphNode().append($createTextNode("Body")));
	}, { discrete: true });
	if (protect) registerDocumentTitle(editor);
	return { editor, key };
}

function tree(editor: LexicalEditor) {
	return editor.getEditorState().read(() =>
		$getRoot().getChildren().map(node => ({
			key: node.getKey(),
			type: node.getType(),
			text: node.getTextContent(),
			tag: $isHeadingNode(node) ? node.getTag() : undefined,
		}))
	);
}

test("registered list transforms reject a title list without a neighboring list", () => {
	let { editor, key } = fixture();
	registerList(editor);
	editor.update(() => {
		let heading = $getRoot().getFirstChild();
		if (!$isElementNode(heading)) throw new Error("missing heading");
		heading.selectEnd();
		$insertList("bullet");
	}, { discrete: true });
	expect(tree(editor)[0]).toEqual({ key, type: "heading", text: "Title", tag: "h1" });
	expect(tree(editor).map(node => node.type)).toEqual(["heading", "paragraph"]);
});

for (let type of ["bullet", "number"] as const) {
	test(`registered ${type} transforms retain inline title content and the adjacent body list`, () => {
		let errors: Error[] = [];
		let editor = createHeadlessEditor({
			nodes: registry().nodes,
			onError: error => errors.push(error),
		});
		registerList(editor);
		let titleKey = "";
		let textKey = "";
		let listKey = "";
		editor.update(() => {
			let text = $createTextNode("title").toggleFormat("bold");
			let heading = $createHeadingNode("h1").append($createTextNode("A "), text);
			let list = $createListNode(type).append(
				$createListItemNode().append($createTextNode("Body item")),
			);
			titleKey = heading.getKey();
			textKey = text.getKey();
			listKey = list.getKey();
			$getRoot().append(
				heading,
				list,
				$createParagraphNode().append($createTextNode("Body prose")),
			);
			text.select(1, 4);
		}, { discrete: true });
		registerDocumentTitle(editor);
		editor.update(() => $insertList(type), { discrete: true });
		expect(errors).toEqual([]);
		expect(tree(editor)).toEqual([
			{ key: titleKey, type: "heading", text: "A title", tag: "h1" },
			{ key: listKey, type: "list", text: "Body item", tag: undefined },
			{ key: expect.any(String), type: "paragraph", text: "Body prose", tag: undefined },
		]);
		editor.getEditorState().read(() => {
			let heading = $getRoot().getFirstChild();
			if (!$isElementNode(heading)) throw new Error("missing title");
			expect(heading.getChildren().every(node => node.isInline())).toBe(true);
			expect(heading.getAllTextNodes()[1]?.hasFormat("bold")).toBe(true);
			let selection = $getSelection();
			expect(
				$isRangeSelection(selection) && {
					anchor: selection.anchor.key,
					start: selection.anchor.offset,
					focus: selection.focus.key,
					end: selection.focus.offset,
				},
			).toEqual({ anchor: textKey, start: 1, focus: textKey, end: 4 });
		});
	});
}

for (let command of [INSERT_UNORDERED_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND]) {
	test(`a registered ${command.type} command preserves an empty title and its caret`, () => {
		let { editor, key } = fixture("");
		registerList(editor);
		editor.update(() => {
			let heading = $getRoot().getFirstChild();
			if (!$isElementNode(heading)) throw new Error("missing heading");
			heading.selectStart();
			expect(editor.dispatchCommand(command, undefined)).toBe(true);
		}, { discrete: true });
		expect(tree(editor).map(node => node.type)).toEqual(["heading", "paragraph"]);
		editor.getEditorState().read(() => {
			let selection = $getSelection();
			expect($isRangeSelection(selection) && selection.anchor.key).toBe(key);
		});
	});
}

test("registered list commands still convert ordinary body prose", () => {
	let { editor, key } = fixture();
	registerList(editor);
	editor.update(() => {
		let body = $getRoot().getLastChild();
		if (!$isElementNode(body)) throw new Error("missing body");
		body.selectStart();
		editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
	}, { discrete: true });
	expect(tree(editor)[0]).toEqual({ key, type: "heading", text: "Title", tag: "h1" });
	expect(tree(editor).map(node => ({ type: node.type, text: node.text }))).toEqual([
		{ type: "heading", text: "Title" },
		{ type: "list", text: "Body" },
	]);
});

test("the actual callout conversion restores inline title content without a paragraph child", () => {
	let { editor, key } = fixture();
	let textKey = "";
	editor.update(() => {
		let heading = $getRoot().getFirstChild();
		if (!$isElementNode(heading)) throw new Error("missing heading");
		let text = heading.getAllTextNodes()[0]!;
		textKey = text.getKey();
		text.select(1, 4);
		let command = availableCommands("").find(command => command.id === "callout");
		if (command?.kind !== "insert") throw new Error("missing callout command");
		command.run(editor);
	}, { discrete: true });
	expect(tree(editor)[0]).toEqual({ key, type: "heading", text: "Title", tag: "h1" });
	expect(tree(editor).map(node => node.type)).toEqual(["heading", "paragraph"]);
	editor.getEditorState().read(() => {
		let heading = $getRoot().getFirstChild();
		if (!$isElementNode(heading)) throw new Error("missing heading");
		expect(heading.getChildren().every(node => node.isInline())).toBe(true);
		let selection = $getSelection();
		expect($isRangeSelection(selection) && selection.anchor.key).toBe(textKey);
	});
});

test("formatting a title as a paragraph retains its name and node identity", () => {
	let { editor, key } = fixture();
	editor.update(() => {
		($getRoot().getFirstChild() as ReturnType<typeof $createHeadingNode>).selectEnd();
		let selection = $getSelection();
		if ($isRangeSelection(selection)) $setBlocksType(selection, $createParagraphNode);
	}, { discrete: true });
	expect(tree(editor)[0]).toEqual({ key, type: "heading", tag: "h1", text: "Title" });
});

test("removing the tracked title never promotes or truncates a body H1", () => {
	let { editor } = fixture();
	let bodyKey = "";
	editor.update(() => {
		let title = $getRoot().getFirstChild()!;
		let body = $createHeadingNode("h1").append($createTextNode("b".repeat(60)));
		bodyKey = body.getKey();
		title.insertAfter(body);
		title.remove();
	}, { discrete: true });
	expect(tree(editor).slice(0, 2).map(({ key, text, tag }) => ({ key, text, tag }))).toEqual([
		{ key: expect.any(String), text: "", tag: "h1" },
		{ key: bodyKey, text: "b".repeat(60), tag: "h1" },
	]);
});

test("Enter preserves the whole title and selects a body paragraph", () => {
	let { editor, key } = fixture();
	editor.update(() => {
		let heading = $getRoot().getFirstChild();
		if ($isElementNode(heading)) heading.selectStart();
		expect(editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined)).toBe(true);
		let selection = $getSelection();
		expect($isRangeSelection(selection) && selection.anchor.getNode().getKey()).not.toBe(key);
	}, { discrete: true });
	expect(tree(editor)[0]?.text).toBe("Title");
});

test("backward deletion at the first body start cannot merge the title", () => {
	let { editor } = fixture();
	editor.update(() => {
		let body = $getRoot().getLastChild();
		if ($isElementNode(body)) body.selectStart();
		expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
	}, { discrete: true });
	expect(tree(editor).map(node => node.text)).toEqual(["Title", "Body"]);
});

test("an element caret at the root title boundary cannot delete either block", () => {
	let { editor } = fixture();
	editor.update(() => {
		$getRoot().select(1, 1);
		expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
		expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, false)).toBe(true);
	}, { discrete: true });
	expect(tree(editor).map(node => node.text)).toEqual(["Title", "Body"]);
});

test("a late server title is adopted before local protection starts", () => {
	let { editor } = fixture("Title", false);
	// A fresh legacy editor has synced while its implementation still locks activation.
	editor.update(() => {
		$getRoot().clear().append($createParagraphNode());
	}, {
		discrete: true,
		tag: COLLABORATION_TAG,
	});
	registerDocumentTitle(editor);
	editor.update(() => {
		$getRoot().getFirstChild()?.remove();
	}, { discrete: true });
	expect(tree(editor).some(node => node.tag === "h1")).toBe(false);
	editor.update(() => {
		$getRoot().clear().append($createHeadingNode("h1").append($createTextNode("Server title")));
	}, { discrete: true, tag: COLLABORATION_TAG });
	editor.update(() => {
		$getRoot().getFirstChild()?.remove();
	}, { discrete: true });
	expect(tree(editor).map(node => node.tag)).toEqual(["h1"]);
});

test("a title alone does not count as substantive prose", () => {
	let { editor } = fixture();
	editor.update(() => {
		$getRoot().getLastChild()?.remove();
	}, { discrete: true });
	expect(editor.getEditorState().read(() => collectPlanState().hasPlanContent)).toBe(false);
});

test("a title-spanning deletion still defers to protected decision guards", () => {
	let { editor } = fixture();
	registerDecisionDeletion(editor, undefined, undefined);
	editor.registerCommand(REMOVE_TEXT_COMMAND, () => {
		let selection = $getSelection();
		if (!$isRangeSelection(selection)) return false;
		selection.removeText();
		return true;
	}, COMMAND_PRIORITY_LOW);
	editor.update(() => {
		$getRoot().getFirstChild()!.insertAfter($createQuestionnaireNode({
			id: "decided",
			questions: [],
			status: "decided",
		}));
		$getRoot().select(0, $getRoot().getChildrenSize());
		expect(editor.dispatchCommand(REMOVE_TEXT_COMMAND, null)).toBe(true);
	}, { discrete: true });
	expect(tree(editor).map(node => node.type)).toEqual([
		"heading",
		"plan-questionnaire",
		"paragraph",
	]);
	expect(tree(editor)[0]?.text).toBe("Title");
});

test("the final transform bounds committed Unicode text without splitting a surrogate pair", () => {
	let { editor, key } = fixture();
	editor.update(() => {
		let heading = $getRoot().getFirstChild();
		if (!$isElementNode(heading)) throw new Error("no heading");
		let text = $createTextNode("😀".repeat(51));
		heading.clear().append(text);
		text.selectEnd();
	}, { discrete: true });
	expect(tree(editor)[0]).toEqual({ key, type: "heading", tag: "h1", text: "😀".repeat(50) });
	editor.getEditorState().read(() => {
		let selection = $getSelection();
		expect($isRangeSelection(selection) && selection.anchor.offset).toBe(100);
	});
});

for (let command of ["delete", "replace"] as const) {
	test(`a title-spanning ${command} retains the unselected body suffix`, () => {
		let { editor } = fixture();
		editor.update(() => {
			let heading = $getRoot().getFirstChild();
			let body = $getRoot().getLastChild();
			if (!$isElementNode(heading) || !$isElementNode(body)) throw new Error("missing blocks");
			heading.getAllTextNodes()[0]!.select(3, 3);
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) throw new Error("missing range");
			selection.focus.set(body.getAllTextNodes()[0]!.getKey(), 2, "text");
			if (command === "delete") editor.dispatchCommand(REMOVE_TEXT_COMMAND, null);
			else editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, "le");
		}, { discrete: true });
		expect(tree(editor).map(node => node.text)).toEqual([
			command === "delete" ? "Tit" : "Title",
			"dy",
		]);
	});
}

for (let name of ["", "Remote title"]) {
	test(`a remote ${name ? "named" : "empty"} title replacement is adopted even when transforms are skipped`, () => {
		let { editor } = fixture();
		let key = "";
		editor.update(() => {
			let heading = $createHeadingNode("h1").append($createTextNode(name));
			key = heading.getKey();
			$getRoot().getFirstChild()!.replace(heading);
		}, { discrete: true, skipTransforms: true, tag: COLLABORATION_TAG });
		editor.update(() => {
			let body = $getRoot().getLastChild();
			if (!$isElementNode(body)) throw new Error("missing body");
			body.selectStart();
			expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
		}, { discrete: true });
		expect(tree(editor)[0]).toEqual({ key, type: "heading", tag: "h1", text: name });
		expect(tree(editor)[1]?.text).toBe("Body");
		editor.update(() => {
			let heading = $getRoot().getFirstChild();
			if (!$isElementNode(heading)) throw new Error("missing title");
			heading.selectEnd();
			expect(editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, " edited")).toBe(true);
		}, { discrete: true });
		expect(tree(editor)[0]?.text).toBe(`${name} edited`);
	});
}

for (let editable of [true, false]) {
	test(`a title-only import ${editable ? "prepares" : "does not rewrite"} an empty body caret when ${editable ? "editable" : "read-only"}`, () => {
		let { editor, key } = fixture("Title", false);
		editor.update(() => $getRoot().getLastChild()!.remove(), { discrete: true });
		registerDocumentTitle(editor, editable);
		editor.update(() => {}, { discrete: true });
		expect(tree(editor)[0]).toEqual({ key, type: "heading", tag: "h1", text: "Title" });
		expect(tree(editor).map(node => node.type)).toEqual(
			editable ? ["heading", "paragraph"] : ["heading"],
		);
		if (!editable) return;
		editor.update(() => {
			let body = $getRoot().getLastChild();
			if (!$isElementNode(body)) throw new Error("missing caret paragraph");
			body.selectStart();
			expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) throw new Error("missing body caret");
			selection.insertText("First body prose.");
		}, { discrete: true });
		expect(tree(editor).map(node => node.text)).toEqual(["Title", "First body prose."]);
	});
}
