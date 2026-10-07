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

import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { clear, decidedRanges, holds, paint, paintDecided, pin, union, unpin } from "./marks";

import { QuestionnaireStore } from "./questionnaires";
import { ThreadStore } from "./threads";

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

/** Advance pin timers synchronously, without depending on scheduler load. */
function withClock(test: (advance: (ms: number) => void) => void): void {
	let now = 0;
	let next = 0;
	let timers = new Map<number, { at: number; callback: () => void }>();
	let schedule = spyOn(globalThis, "setTimeout").mockImplementation(
		(
			(callback: () => void, delay = 0) => {
				let id = next++;
				timers.set(id, { at: now + delay, callback });
				return id;
			}
		) as typeof setTimeout,
	);
	let cancel = spyOn(globalThis, "clearTimeout").mockImplementation(timer => {
		timers.delete(timer as unknown as number);
	});
	try {
		test(ms => {
			let target = now + ms;
			while (true) {
				let due = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
				if (!due || due[1].at > target) break;
				now = due[1].at;
				timers.delete(due[0]);
				due[1].callback();
			}
			now = target;
		});
	} finally {
		clear();
		cancel.mockRestore();
		schedule.mockRestore();
	}
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

	it("goes out on its own, so it cannot become a standing mark", () => {
		withClock(advance => {
			pin(editor, "comments", [points("c")], 30);
			advance(29);
			expect(union()).toEqual([points("c")]);
			expect(holds("comments")).toBe(true);

			advance(1);
			expect(union()).toEqual([]);
			expect(holds("comments")).toBe(false);
		});
	});

	/** Walking to the next place has to keep the pin alive, or it cannot be walked. */
	it("starts the clock again each time it is asked", () => {
		withClock(advance => {
			pin(editor, "comments", [points("c1")], 30);
			advance(15);
			pin(editor, "comments", [points("c2")], 30);

			advance(16);
			expect(union()).toEqual([points("c2")]);
			expect(holds("comments")).toBe(true);
			advance(13);
			expect(union()).toEqual([points("c2")]);

			advance(1);
			expect(union()).toEqual([]);
			expect(holds("comments")).toBe(false);
		});
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

describe("decided wash", () => {
	it("keeps decisions separate from related marks and their pin", () => {
		pin(editor, "comments", [points("comment")]);
		paint(editor, "decisions", []);
		pin(editor, "decisions", [points("decision")]);

		expect(union()).toEqual([points("comment")]);
		expect(holds("comments")).toBe(true);
		expect(holds("decisions")).toBe(false);
	});

	it("keeps each mounted editor's ranges when another editor repaints or clears", () => {
		let parent = { ...editor } as LexicalEditor;
		let child = { ...editor } as LexicalEditor;
		let parentRange = {} as Range;
		let childRange = {} as Range;

		paintDecided(parent, [parentRange]);
		paintDecided(child, [childRange]);
		expect(decidedRanges()).toEqual([parentRange, childRange]);

		clear(child);
		expect(decidedRanges()).toEqual([parentRange]);

		clear();
		expect(decidedRanges()).toEqual([]);
	});
});

describe("mounted editor ownership", () => {
	it("merges related marks from parent and child and clears only the departing surface", () => {
		let child = { ...editor } as LexicalEditor;
		paint(editor, "questions", [points("parent")]);
		paint(child, "questions", [points("child")]);
		expect(union()).toEqual([points("parent"), points("child")]);
		clear(child);
		expect(union()).toEqual([points("parent")]);
	});

	it("clearing another editor does not release the reader's current pin", () => {
		let child = { ...editor } as LexicalEditor;
		pin(editor, "questions", [points("parent")]);
		clear(child);
		expect(union()).toEqual([points("parent")]);
		expect(holds("questions")).toBe(true);
	});
});

describe("pin release ownership", () => {
	it("a child store releasing questions cannot release the parent's question pin", () => {
		let child = { ...editor } as LexicalEditor;
		pin(editor, "questions", [points("parent")]);
		unpin(child, "questions");
		expect(union()).toEqual([points("parent")]);
		expect(holds("questions")).toBe(true);
		unpin(editor, "questions");
		expect(union()).toEqual([]);
	});
});

describe("sidecar editor ownership", () => {
	it("walking continues only in the editor that still owns the pin", () => {
		let child = { ...editor } as LexicalEditor;
		pin(editor, "questions", [points("parent")]);
		expect(holds("questions", editor)).toBe(true);
		expect(holds("questions", child)).toBe(false);
	});

	it("an unbound questionnaire store cannot release another surface's question pin", () => {
		pin(editor, "questions", [points("parent")]);
		new QuestionnaireStore().release();
		expect(union()).toEqual([points("parent")]);
	});

	it("detaching a child questionnaire store keeps the parent's pin", () => {
		let child = { ...editor } as LexicalEditor;
		let store = new QuestionnaireStore();
		store.attach(child);
		pin(editor, "questions", [points("parent")]);
		store.attach(undefined);
		expect(union()).toEqual([points("parent")]);
	});

	it("detaching a child thread store, including repeated detach, keeps the parent's pin", () => {
		let child = { ...editor } as LexicalEditor;
		let store = new ThreadStore();
		store.attach(child);
		pin(editor, "questions", [points("parent")]);
		store.attach(undefined);
		expect(union()).toEqual([points("parent")]);
		store.attach(undefined);
		expect(union()).toEqual([points("parent")]);
	});

	it("replacing a thread store's editor clears only its previous editor's ranges", () => {
		let child = { ...editor } as LexicalEditor;
		let replacement = { ...editor } as LexicalEditor;
		let store = new ThreadStore();
		store.attach(child);
		pin(editor, "questions", [points("parent")]);
		paint(child, "comments", [points("child")]);
		store.attach(replacement);
		expect(union()).toEqual([points("parent")]);
		unpin();
		expect(union()).toEqual([]);
	});
});
