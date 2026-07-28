/**
 * Two stores, one registry.
 *
 * `CSS.highlights` is document-wide and painting sets it wholesale, so the
 * question sidecar and the comment sidecar cannot each own it — the second to
 * repaint would erase the first. What is worth pinning is that they coexist:
 * declaring what one wants marked never drops what the other asked for.
 *
 * The registration itself is not tested. There is no `CSS.highlights` in the
 * test runtime and no layout to measure, which is the same reason the toolbar's
 * placement has no test either.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { clear, paint, union } from "./marks";

import type { LexicalEditor } from "lexical";
import type { Points } from "./passage";

/**
 * Enough of an editor for painting to run through.
 *
 * Reads pass straight through; there is no DOM, so the fallback finds no
 * elements and does nothing, which is what we want it to do here.
 */
let editor = {
	getEditorState: () => ({ read: (fn: () => void) => fn() }),
	getElementByKey: () => null,
	getRootElement: () => null,
} as unknown as LexicalEditor;

function points(key: string): Points {
	return { anchorKey: key, anchorOffset: 0, focusKey: key, focusOffset: 1 };
}

afterEach(() => {
	clear();
});

describe("sharing the registry", () => {
	it("keeps what each store asked for", () => {
		paint(editor, "questions", [points("q")]);
		paint(editor, "comments", [points("c")]);

		expect(union()).toEqual([points("q"), points("c")]);
	});

	/** The bug this exists for: repainting one used to wipe the other. */
	it("does not drop one store's marks when the other repaints", () => {
		paint(editor, "comments", [points("c")]);
		paint(editor, "questions", [points("q")]);
		paint(editor, "questions", [points("q2")]);

		expect(union()).toEqual([points("c"), points("q2")]);
	});

	it("removes only its own when a store asks for nothing", () => {
		paint(editor, "comments", [points("c")]);
		paint(editor, "questions", [points("q")]);

		paint(editor, "questions", []);

		expect(union()).toEqual([points("c")]);
	});

	it("marks both at once when a reader points at one of each", () => {
		paint(editor, "questions", [points("q")]);
		paint(editor, "comments", [points("c1"), points("c2")]);

		expect(union()).toEqual([points("q"), points("c1"), points("c2")]);
	});

	it("takes everything down when the editor goes away", () => {
		paint(editor, "questions", [points("q")]);
		paint(editor, "comments", [points("c")]);

		clear();

		expect(union()).toEqual([]);
	});

	/**
	 * Reached from a Lexical update listener, where a throw skips every
	 * listener after it — including the one that syncs the document.
	 */
	it("never throws, whatever the editor does", () => {
		let broken = {
			getEditorState() {
				throw new Error("the editor is gone");
			},
		} as unknown as LexicalEditor;

		let complain = console.error;
		console.error = () => {};
		try {
			expect(() => paint(broken, "comments", [points("c")]))
				.not.toThrow();
		} finally {
			console.error = complain;
		}
	});
});
