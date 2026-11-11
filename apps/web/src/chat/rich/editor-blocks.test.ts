import { describe, expect, it } from "bun:test";

import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { $getSelection, $isRangeSelection, createEditor } from "lexical";

import { parseDraft, serializeDraft } from "./draft-markdown";
import {
	$pointOffset,
	$readBlocks,
	$selectOffsets,
	$writeBlocks,
	slotIndex,
} from "./editor-blocks";
import { ChipNode, CodeBlockNode, InterimNode, MentionNode } from "./nodes";

import type { ReferenceDraft } from "../references";

function draftEditor() {
	return createEditor({
		nodes: [ListNode, ListItemNode, LinkNode, ChipNode, MentionNode, CodeBlockNode, InterimNode],
		onError: error => {
			throw error;
		},
	});
}

/** Markdown read into the rich draft's tree, then written back from what the tree holds. */
function throughTheDraft(markdown: string, references: ReferenceDraft[] = []) {
	let editor = draftEditor();
	editor.update(() => $writeBlocks(parseDraft(markdown, references)), { discrete: true });
	return editor.getEditorState().read(() => serializeDraft($readBlocks()));
}

describe("the rich draft's tree and the Markdown a message is sent as", () => {
	it("gives back every format exactly as it was written, through the editor's own nodes", () => {
		for (
			let markdown of [
				"",
				"plain words",
				"**bold** and _italic_ and ~~struck~~",
				"`code` in a line",
				"a [link](https://example.com) here",
				"a [**bold link**](https://example.com)",
				"**_both_** at once",
				"intra*word*emphasis",
				"- one\n- two",
				"1. first\n2. second",
				"3. third\n4. fourth",
				"```\nlet x = 1;\n\nlet y = 2;\n```",
				"intro\n- one\n- two\n\nafter",
				"a\n\nb",
				"line one\nline two",
				"trailing\n",
				"> a quote stays as written",
				"* a star bullet stays as written",
				"2 * 3 * 4 and snake_case_name",
			]
		) {
			expect(throughTheDraft(markdown).markdown).toBe(markdown);
		}
	});

	it("keeps mentions as their words and references as chips, at the same places", () => {
		let text = "Ask @mona about @Release plan and #Roadmap **now** with @src/a.ts";
		let references: ReferenceDraft[] = [
			{ kind: "heading", anchor: "release-plan", start: 16, end: 29, token: "@Release plan" },
			{ kind: "document", channelId: "c1", start: 34, end: 42, token: "#Roadmap" },
			{ kind: "file", path: "src/a.ts", start: 56, end: 65, token: "@src/a.ts" },
		];
		let result = throughTheDraft(text, references);
		expect(result.markdown).toBe(text);
		expect(result.references).toEqual(references);
		let command: ReferenceDraft[] = [
			{
				kind: "command",
				name: "review",
				commandKind: "prompt",
				start: 0,
				end: 7,
				token: "/review",
			},
		];
		expect(throughTheDraft("/review the _plan_", command)).toEqual(
			expect.objectContaining({ markdown: "/review the _plan_", references: command }),
		);
	});

	it("puts a caret at the offset it was asked for, and reads it back as the same offset", () => {
		let markdown = "say **bold** and `x`\n- one\n- two\n\n```\nab\ncd\n```";
		let editor = draftEditor();
		editor.update(() => $writeBlocks(parseDraft(markdown)), { discrete: true });
		let index = editor.getEditorState().read(() => slotIndex(serializeDraft($readBlocks())));
		// Every offset of words, rather than of marks, comes back as itself.
		let words = [0, 3, 4, 6, 10, 12, 16, 18, 19, 23, 26, 29, 32, 38, 39, 40, 41, 43];
		for (let offset of words) {
			let read = -1;
			editor.update(() => {
				$selectOffsets(offset, offset, index);
				let selection = $getSelection();
				if ($isRangeSelection(selection)) read = $pointOffset(selection.anchor, index);
			}, { discrete: true });
			expect([offset, read]).toEqual([offset, offset]);
		}
		// An offset inside the marks of a format is the start of the words after them.
		let inside = -1;
		editor.update(() => {
			$selectOffsets(5, 5, index);
			let selection = $getSelection();
			if ($isRangeSelection(selection)) inside = $pointOffset(selection.anchor, index);
		}, { discrete: true });
		expect(inside).toBe(6);
	});
});
