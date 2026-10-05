import { describe, expect, it } from "bun:test";
import { $createLinkNode, $isLinkNode } from "@lexical/link";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	COLLABORATION_TAG,
	createEditor,
	PASTE_TAG,
} from "lexical";

import { registry } from "@chopin/dialect";

import { registerLinkGuard } from "./link-guard";

import type { LexicalEditor } from "lexical";

const BACKSLASH = String.fromCharCode(92);

function open(): LexicalEditor {
	let editor = createEditor({
		nodes: registry().nodes,
		onError: error => {
			throw error;
		},
	});
	registerLinkGuard(editor);
	return editor;
}

/** Insert one linked paragraph the way a paste or a remote update would. */
function insert(editor: LexicalEditor, url: string, tag: string): void {
	editor.update(() => {
		let link = $createLinkNode(url).append($createTextNode("pasted"));
		$getRoot().append($createParagraphNode().append(link));
	}, { discrete: true, tag });
}

function links(editor: LexicalEditor): string[] {
	return editor.getEditorState().read(() =>
		$getRoot().getAllTextNodes().flatMap(text => {
			let parent = text.getParent();
			return $isLinkNode(parent) ? [parent.getURL()] : [];
		})
	);
}

function text(editor: LexicalEditor): string {
	return editor.getEditorState().read(() => $getRoot().getTextContent());
}

describe("links that arrive by paste", () => {
	it("unwraps an address the server would refuse, keeping its text", () => {
		let zeroWidth = `https://ex${String.fromCharCode(0x200b)}ample.com`;
		for (let url of ["//cdn.example.com/a.js", zeroWidth, "http://example.com", "javascript:x"]) {
			let editor = open();
			insert(editor, url, PASTE_TAG);
			expect(links(editor)).toEqual([]);
			expect(text(editor)).toBe("pasted");
		}
	});

	it("keeps an acceptable address and normalises a bare domain", () => {
		let editor = open();
		insert(editor, "https://example.com/a", PASTE_TAG);
		insert(editor, "example.com/b", PASTE_TAG);
		expect(links(editor)).toEqual(["https://example.com/a", "https://example.com/b"]);
	});

	/** The server judges what collaborators send; a stored link must not be stripped on open. */
	it("leaves links arriving from collaboration alone", () => {
		let editor = open();
		let stored = `docs${BACKSLASH}notes.md`;
		insert(editor, stored, COLLABORATION_TAG);
		expect(links(editor)).toEqual([stored]);
	});
});
