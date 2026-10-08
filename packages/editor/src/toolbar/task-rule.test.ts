import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $isListItemNode, $isListNode } from "@lexical/list";
import { $getRoot, KEY_DOWN_COMMAND } from "lexical";

import { exportPlan, importPlan, registry } from "@chopin/dialect";

import { registerTaskRule, taskMarker } from "./task-rule";

import type { LexicalEditor } from "lexical";

describe("taskMarker", () => {
	it("reads the three marker spellings", async () => {
		expect(taskMarker("[]")).toEqual({ checked: false });
		expect(taskMarker("[ ]")).toEqual({ checked: false });
		expect(taskMarker("[x]")).toEqual({ checked: true });
		expect(taskMarker("[X]")).toEqual({ checked: true });
	});

	it("leaves ordinary text alone", async () => {
		for (let text of ["", "[", "[y]", "[ ] a", "a [ ]", "[  ]", "[xx]"]) {
			expect(taskMarker(text)).toBeUndefined();
		}
	});
});

/**
 * An editor holding `source`, with the caret at the end of the item written
 * `Q`, whose text becomes `at`. Markdown will not import an item that is only
 * a marker, so the marker is typed in afterwards.
 */
function editorAt(source: string, at: string): LexicalEditor {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError: error => {
			throw error;
		},
	});
	importPlan(editor, source);
	editor.update(() => {
		let node = $getRoot().getAllTextNodes().find(node => node.getTextContent() === "Q");
		node?.setTextContent(at);
		node?.select(at.length, at.length);
	}, { discrete: true });
	registerTaskRule(editor);
	return editor;
}

function space(editor: LexicalEditor, over: Partial<KeyboardEvent> = {}): boolean {
	let prevented = false;
	editor.dispatchCommand(KEY_DOWN_COMMAND, {
		key: " ",
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		isComposing: false,
		preventDefault: () => {
			prevented = true;
		},
		...over,
	} as KeyboardEvent);
	return prevented;
}

/** Commands commit on a microtask, so state is read after it. */
async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
}

function markdown(editor: LexicalEditor): string {
	return exportPlan(editor).trim();
}

describe("task rule", () => {
	it("turns a bullet holding only [ ] into an empty task item", async () => {
		let editor = editorAt("- Q", "[ ]");
		expect(space(editor)).toBe(true);
		await settle();
		expect(
			editor.getEditorState().read(() => {
				let list = $getRoot().getFirstChild();
				return $isListNode(list) && list.getListType();
			}),
		).toBe("check");
	});

	it("checks the item for [x]", async () => {
		let editor = editorAt("- Q", "[x]");
		expect(space(editor)).toBe(true);
		await settle();
		let checked = editor.getEditorState().read(() => {
			let list = $getRoot().getFirstChild();
			let item = $isListNode(list) ? list.getFirstChild() : undefined;
			return $isListItemNode(item) && item.getChecked();
		});
		expect(checked).toBe(true);
	});

	it("splits a longer bullet list around the converted item", async () => {
		let editor = editorAt("- one\n- Q\n- three", "[ ]");
		expect(space(editor)).toBe(true);
		await settle();
		let types = editor.getEditorState().read(() =>
			$getRoot().getChildren().map(node => $isListNode(node) ? node.getListType() : "other")
		);
		expect(types).toEqual(["bullet", "check", "bullet"]);
	});

	it("keeps a first item's list order", async () => {
		let editor = editorAt("- Q\n- two", "[ ]");
		expect(space(editor)).toBe(true);
		await settle();
		let types = editor.getEditorState().read(() =>
			$getRoot().getChildren().map(node => $isListNode(node) ? node.getListType() : "other")
		);
		expect(types).toEqual(["check", "bullet"]);
	});

	it("leaves a nested item literal, even when it is the only one", async () => {
		let editor = editorAt("- top\n  - Q", "[ ]");
		expect(space(editor)).toBe(false);
		await settle();
		expect(markdown(editor)).toContain("\\[ ]");
	});

	it("ignores a space after other text, modifiers and composition", async () => {
		let editor = editorAt("- Q", "a [ ]");
		expect(space(editor)).toBe(false);

		editor = editorAt("- Q", "[ ]");
		expect(space(editor, { metaKey: true })).toBe(false);
		expect(space(editor, { isComposing: true })).toBe(false);
		expect(markdown(editor)).toBe("- \\[ ]");
	});

	it("leaves a plain paragraph to the markdown shortcuts", async () => {
		let editor = editorAt("Q", "[ ]");
		expect(space(editor)).toBe(false);
	});
});
