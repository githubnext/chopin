/**
 * Keeping a comment pointed at the right phrase.
 *
 * A passage is a block run plus a range inside it, and the range is held twice
 * over: Yjs relative positions, which stretch as somebody types inside the
 * phrase, and the quoted text, which finds it again when they cannot be
 * resolved. The cases worth pinning are the ones where each layer is the only
 * one left — an edit inside the phrase, a block that moved, an epoch rotation —
 * and the ones where neither is, which must say so rather than guess.
 *
 * This also pins arithmetic that `@lexical/yjs` does not export. If a version
 * bump changes how a text node's characters are indexed inside its parent,
 * these fail rather than the highlight quietly landing a word to the left.
 */

import { describe, expect, it } from "bun:test";
import { $getNodeByKey, $getRoot, $isElementNode, $isParagraphNode } from "lexical";

import * as edit from "./edit";
import * as room from "./room";

import type { Document } from "./room";
import type { Plan as Room } from "./service";

const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.

The third paragraph.
`;

async function plan(source = SOURCE): Promise<Room> {
	return { document: await room.create(source), revision: 1, outlines: new Map() } as Room;
}

/**
 * Mark a phrase, the way the client's request does.
 *
 * The offset is a hint the server searches near, so zero is honest here: it is
 * exactly as much as a client that miscounted would supply.
 */
function mark(document: Document, indices: number[], quote: string, offset = 0) {
	return room.passageAt(document, indices, quote, offset, quote.length);
}

/**
 * Edit a block's text the way a keystroke does.
 *
 * Not `edit_plan replace`, which swaps the whole block and takes its
 * collaborative identity with it. A person typing splices the text node, which
 * is the case the relative positions exist to survive.
 */
function retype(document: Document, index: number, find: string, replacement: string): void {
	document.editor.update(() => {
		let blocks = $getRoot().getChildren().filter(
			node => !($isParagraphNode(node) && node.getChildrenSize() === 0),
		);
		let block = blocks[index];
		if (!$isElementNode(block)) throw new Error("not an element");

		for (let leaf of block.getAllTextNodes()) {
			let text = leaf.getTextContent();
			let at = text.indexOf(find);
			if (at === -1) continue;
			leaf.setTextContent(text.slice(0, at) + replacement + text.slice(at + find.length));
			return;
		}
		throw new Error(`no "${find}" in block ${index}`);
	}, { discrete: true });
}

/** What the passage covers now, read back out of the document itself. */
function reads(document: Document, passage: ReturnType<typeof mark>): string | undefined {
	let points = room.locate(document, passage);
	if (!points) return undefined;

	let text: string | undefined;
	document.editor.getEditorState().read(() => {
		let anchor = $getNodeByKey(points.anchorKey);
		// Single-node ranges only: enough to prove the arithmetic, and a
		// cross-node reconstruction here would just reimplement the thing
		// under test.
		if (anchor && points.anchorKey === points.focusKey) {
			text = anchor.getTextContent().slice(points.anchorOffset, points.focusOffset);
		}
	});
	return text;
}

const QUOTE = "caches tiles for 60 seconds";

describe("marking a passage", () => {
	it("names a phrase, and can find it again", async () => {
		let subject = await plan();
		let passage = mark(subject.document, [1], QUOTE);

		expect(passage.quote).toBe(QUOTE);
		expect(passage.length).toBe(QUOTE.length);
		expect(passage.blocks).toHaveLength(1);
		expect(room.locate(subject.document, passage)).toBeDefined();
		expect(reads(subject.document, passage)).toBe(QUOTE);
	});

	it("refuses a block that is not there", async () => {
		let subject = await plan();
		expect(() => room.passageAt(subject.document, [9], QUOTE, 0, 3))
			.toThrow(/no block at index/);
	});

	/**
	 * Finding the quote is the concurrency check. If the plan moved so that the
	 * blocks named no longer hold the phrase, marking whatever sits there now
	 * would be worse than refusing and asking for the selection again.
	 */
	it("refuses a phrase that is not in the blocks named", async () => {
		let subject = await plan();
		expect(() => room.passageAt(subject.document, [1], "not here", 0, 8))
			.toThrow(/not in those blocks/);
	});

	it("spans a run of blocks", async () => {
		let subject = await plan();
		let passage = mark(subject.document, [1, 2], "60 seconds.\nThe second");

		expect(passage.blocks).toHaveLength(2);
		expect(room.locate(subject.document, passage)).toBeDefined();
	});
});

describe("a passage as the plan changes", () => {
	/** The property the quote alone cannot give. */
	it("stretches when text is typed inside the phrase", async () => {
		let subject = await plan();
		let passage = mark(subject.document, [1], QUOTE);

		retype(subject.document, 1, "60 seconds", "60 whole seconds");

		let rebased = room.rebasePassage(subject.document, passage);
		expect(rebased.drifted).toBeUndefined();
		// The range grew with the sentence rather than snapping off it.
		expect(rebased.quote).toBe("caches tiles for 60 whole seconds");
		expect(reads(subject.document, rebased)).toBe("caches tiles for 60 whole seconds");
	});

	it("survives an insertion above it", async () => {
		let subject = await plan();
		let passage = mark(subject.document, [1], QUOTE);

		edit.apply(subject, 1, [{ op: "insert", index: 0, source: "Inserted.\n" }]);

		let rebased = room.rebasePassage(subject.document, passage);
		expect(rebased.drifted).toBeUndefined();
		expect(rebased.quote).toBe(QUOTE);
		expect(reads(subject.document, rebased)).toBe(QUOTE);
	});

	/**
	 * A move rebuilds the block's collaborative identity, so both the block
	 * position and the range inside it die at once. The digest recovers the
	 * block and the quote recovers the range — the two layers, both needed.
	 */
	it("recovers a block that moved, by digest and quote", async () => {
		let subject = await plan();
		let passage = mark(subject.document, [1], QUOTE);

		edit.apply(subject, 1, [{ op: "move", index: 1, to: 0 }]);

		let rebased = room.rebasePassage(subject.document, passage);
		expect(rebased.drifted).toBeUndefined();
		expect(reads(subject.document, rebased)).toBe(QUOTE);
	});

	/** A rotation throws away the history the positions were expressed in. */
	it("recovers across an epoch rotation, by quote", async () => {
		let subject = await plan();
		let passage = mark(subject.document, [1], QUOTE);

		let rotated = await room.replace(room.project(subject.document));
		expect(rotated.epoch).not.toBe(subject.document.epoch);
		expect(room.locate(rotated, passage)).toBeUndefined();

		let rebased = room.rebasePassage(rotated, passage);
		expect(rebased.drifted).toBeUndefined();
		expect(rebased.blocks[0]!.epoch).toBe(rotated.epoch);
		expect(reads(rotated, rebased)).toBe(QUOTE);
	});

	it("drifts when the phrase is rewritten away", async () => {
		let subject = await plan();
		let passage = mark(subject.document, [1], QUOTE);

		edit.apply(subject, 1, [{ op: "replace", index: 1, source: "Something else entirely.\n" }]);

		expect(room.rebasePassage(subject.document, passage).drifted).toBe(true);
	});

	it("drifts when the block it marks is deleted", async () => {
		let subject = await plan();
		let passage = mark(subject.document, [1], QUOTE);

		edit.apply(subject, 1, [{ op: "delete", index: 1 }]);

		expect(room.rebasePassage(subject.document, passage).drifted).toBe(true);
	});

	/**
	 * Two identical phrases in one block give no way to tell which was meant.
	 * The same rule as two identical blocks, and for the same reason: marking
	 * the wrong sentence is worse than admitting the mark is lost.
	 */
	it("refuses to choose between the same phrase twice over", async () => {
		let subject = await plan("# Title\n\nSay it. Say it.\n");
		let passage = mark(subject.document, [1], "Say it.");

		// Rotate so only the quote is left, and put the two occurrences the
		// same distance from where the mark was made.
		edit.apply(subject, 1, [{ op: "replace", index: 1, source: "Say it. x Say it.\n" }]);
		let rotated = await room.replace(room.project(subject.document));

		expect(room.rebasePassage(rotated, { ...passage, offset: 5 }).drifted).toBe(true);
	});

	it("keeps a drifted passage drifted rather than re-finding it", async () => {
		let subject = await plan();
		let passage = mark(subject.document, [1], QUOTE);

		let drifted = room.rebasePassage(subject.document, { ...passage, drifted: true });
		// It is kept, on the current epoch, and still says what it marked.
		expect(drifted.quote).toBe(QUOTE);
	});
});

describe("reading a passage back", () => {
	it("reports the current text of the blocks it covers", async () => {
		let subject = await plan();
		let passage = mark(subject.document, [1], QUOTE);

		expect(room.passageText(subject.document, passage))
			.toBe("The renderer caches tiles for 60 seconds.");
	});
});
