import { describe, expect, it } from "bun:test";

import { addExportVisitor$, corePlugin, rootEditor$ } from "@mdxeditor/editor";
import { Realm } from "@mdxeditor/gurx";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";

import { collaborationPlugin } from "./collaboration";

import type { LexicalEditor, LexicalNode } from "lexical";

/**
 * MDXEditor's core as `<MDXEditor>` installs it, with its root editor built, and a visitor that
 * counts every node its Markdown export visits.
 */
function mount(collaborative: boolean): { editor: LexicalEditor; visits: () => number } {
	let realm = new Realm();
	let host = corePlugin({
		contentEditableClassName: "plan-content",
		readOnly: false,
		initialMarkdown: "",
		spellCheck: true,
		toMarkdownOptions: {},
		autoFocus: false,
		placeholder: "",
		iconComponentFor: () => null as never,
		suppressHtmlProcessing: true,
		translation: (_key: string, fallback: string) => fallback,
		trim: true,
		onChange: () => {},
		onBlur: () => {},
		onError: () => {},
		additionalLexicalNodes: [],
		lexicalEditorNamespace: "Test",
	});
	let visits = 0;
	host.init?.(realm);
	realm.pub(addExportVisitor$, {
		priority: 1000,
		testLexicalNode: (_node: LexicalNode): _node is LexicalNode => {
			visits++;
			return false;
		},
		visitLexicalNode: () => {},
	});
	if (collaborative) {
		collaborationPlugin({ wire: undefined as never, user: { name: "ana", color: "#000" } }).init?.(
			realm,
		);
	}
	host.postInit?.(realm);
	return { editor: realm.getValue(rootEditor$)!, visits: () => visits };
}

function type(editor: LexicalEditor, text: string): void {
	editor.update(() => {
		$getRoot().append($createParagraphNode().append($createTextNode(text)));
	}, { discrete: true });
}

describe("collaboration", () => {
	it("leaves the document's Markdown to the server, so a keystroke walks none of it", () => {
		// The control: MDXEditor alone exports the whole document on each change.
		let plain = mount(false);
		type(plain.editor, "One.");
		type(plain.editor, "Two.");
		expect(plain.visits()).toBeGreaterThan(0);

		let shared = mount(true);
		type(shared.editor, "One.");
		type(shared.editor, "Two.");
		expect(shared.visits()).toBe(0);
	});
});
