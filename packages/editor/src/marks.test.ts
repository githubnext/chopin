/**
 * Two stores, one registry, one pin.
 *
 * `CSS.highlights` is document-wide and painting sets it wholesale, so the
 * question sidecar and the comment sidecar cannot each own it — the second to
 * repaint would erase the first. What is worth pinning is that they coexist:
 * declaring what one wants marked never drops what the other asked for.
 *
 * The pin is the other half. It is what a reader who clicked is left looking
 * at, so it has to survive the pointer leaving the card and give way while the
 * pointer is somewhere else.
 *
 * The registration itself is not tested. There is no `CSS.highlights` in the
 * test runtime and no layout to measure, which is the same reason the toolbar's
 * placement has no test either.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { clear, holds, paint, pin, union, unpin } from "./marks";

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

/** A short one, so a lapse can be watched without waiting five seconds for it. */
const BRIEF = 5;

function tick(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

describe("being sent somewhere", () => {
	it("keeps the mark up after the pointer has left the card", () => {
		pin(editor, "comments", [points("c")]);

		// The hover that lit it is over by the time the click has landed.
		paint(editor, "comments", []);

		expect(union()).toEqual([points("c")]);
	});

	it("lends the mark to whatever the pointer moves to next", () => {
		pin(editor, "comments", [points("c")]);
		paint(editor, "questions", [points("q")]);

		// One wash, and it says what is being pointed at rather than both.
		expect(union()).toEqual([points("q")]);
	});

	it("gives it back when the pointer moves off again", () => {
		pin(editor, "comments", [points("c")]);
		paint(editor, "questions", [points("q")]);
		paint(editor, "questions", []);

		expect(union()).toEqual([points("c")]);
	});

	/** One reader, one pointer: two places at once cannot say which was meant. */
	it("holds one place, whichever half of the sidecar asked", () => {
		pin(editor, "comments", [points("c")]);
		pin(editor, "questions", [points("q")]);

		expect(union()).toEqual([points("q")]);
		expect(holds("comments")).toBe(false);
		expect(holds("questions")).toBe(true);
	});

	it("goes out on its own, so it cannot become a standing mark", async () => {
		pin(editor, "comments", [points("c")], BRIEF);
		expect(union()).toEqual([points("c")]);

		await tick(BRIEF * 4);

		expect(union()).toEqual([]);
		expect(holds("comments")).toBe(false);
	});

	/** Walking to the next place has to keep the pin alive, or it cannot be walked. */
	it("starts the clock again each time it is asked", async () => {
		pin(editor, "comments", [points("c1")], BRIEF * 6);
		await tick(BRIEF * 3);
		pin(editor, "comments", [points("c2")], BRIEF * 6);
		await tick(BRIEF * 3);

		expect(union()).toEqual([points("c2")]);
	});

	it("is only the owner's to drop", () => {
		pin(editor, "comments", [points("c")]);

		unpin(editor, "questions");
		expect(union()).toEqual([points("c")]);

		unpin(editor, "comments");
		expect(union()).toEqual([]);
	});

	it("goes with everything else when the editor does", () => {
		pin(editor, "comments", [points("c")]);

		clear();

		expect(union()).toEqual([]);
		expect(holds("comments")).toBe(false);
	});
});
