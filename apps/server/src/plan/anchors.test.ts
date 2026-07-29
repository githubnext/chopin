/**
 * Keeping a decision pointed at the right passage.
 *
 * An index would be wrong the moment anybody typed above it, so an anchor is a
 * Yjs relative position — and when even that cannot be resolved, a digest of
 * the block's canonical source. The cases worth pinning are the ones where the
 * document has moved underneath: text inserted above, blocks reordered, the
 * block edited, the block deleted, and two blocks that look identical.
 */

import { describe, expect, it } from "bun:test";
import { $getAnchorAndFocusForUserState } from "@lexical/yjs";
import { $getNodeByKey } from "lexical";
import type * as Y from "yjs";

import * as edit from "./edit";
import * as room from "./room";

import type { Plan } from "@chopin/protocol";
import type { Document } from "./room";
import type { Plan as Room } from "./service";

const SOURCE = `# Title

The first paragraph.

The second paragraph.

The third paragraph.
`;

async function plan(source = SOURCE): Promise<Room> {
	return { document: await room.create(source), revision: 1, outlines: new Map() } as Room;
}

/** Anchor the block at `index`, the way the agent's tool does. */
function anchor(document: Document, index: number): Plan.Anchor {
	return room.anchorAt(document, index, room.digests(document)[index]!);
}

describe("anchoring", () => {
	it("names a block, and can find it again", async () => {
		let subject = await plan();
		let value = anchor(subject.document, 2);

		expect(value.epoch).toBe(subject.document.epoch);
		expect(value.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(room.resolveAnchor(subject.document, value)).toBeDefined();
	});

	it("refuses to anchor a block that is not there", async () => {
		let subject = await plan();
		expect(() => room.anchorAt(subject.document, 9, "sha256:x")).toThrow();
	});

	/**
	 * The property an index cannot give. Inserting above the anchored block
	 * shifts its index but not its identity.
	 */
	it("survives an insertion above it", async () => {
		let subject = await plan();
		let value = anchor(subject.document, 2);
		let before = room.resolveAnchor(subject.document, value);

		edit.apply(subject, 1, [{ op: "insert", index: 0, source: "Inserted.\n" }]);

		expect(room.resolveAnchor(subject.document, value)).toBe(before!);
		// And it is the same prose, now one further down.
		expect(room.digests(subject.document)[3]).toBe(value.digest);
	});

	/**
	 * A move rebuilds the block's collaborative identity, so the position dies
	 * even though the prose did not change. This is what the digest is for, and
	 * the case that shows the two layers doing different jobs.
	 */
	it("loses the position when the block moves, and recovers it by digest", async () => {
		let subject = await plan();
		let value = anchor(subject.document, 3);

		edit.apply(subject, 1, [{ op: "move", index: 3, to: 1 }]);
		expect(room.resolveAnchor(subject.document, value)).toBeUndefined();

		let [rebased] = room.rebase(subject.document, [value]);
		expect(rebased?.orphaned).toBeUndefined();
		expect(room.resolveAnchor(subject.document, rebased!)).toBeDefined();
	});

	it("loses a block that was deleted", async () => {
		let subject = await plan();
		let value = anchor(subject.document, 2);

		edit.apply(subject, 1, [{ op: "delete", index: 2 }]);

		expect(room.resolveAnchor(subject.document, value)).toBeUndefined();
	});
});

describe("rebasing", () => {
	/**
	 * Rewriting the anchored passage is the one case neither layer can carry:
	 * the position is gone and the digest describes prose that no longer
	 * exists. It is also the case where recovering would be wrong — whether the
	 * new text still concerns that decision is a judgement, which is why the
	 * agent is told to review it rather than having an answer invented.
	 */
	it("orphans the anchor when the block it names is rewritten", async () => {
		let subject = await plan();
		let value = anchor(subject.document, 2);

		edit.apply(subject, 1, [{ op: "replace", index: 2, source: "Rewritten second.\n" }]);
		let [rebased] = room.rebase(subject.document, [value]);

		expect(rebased?.orphaned).toBe(true);
	});

	it("keeps an anchor whose block was left alone, whatever happened around it", async () => {
		let subject = await plan();
		let value = anchor(subject.document, 2);

		edit.apply(subject, 1, [
			{ op: "insert", index: 0, source: "Added above.\n" },
			{ op: "replace", index: 3, source: "Rewritten elsewhere.\n" },
		]);

		let [rebased] = room.rebase(subject.document, [value]);
		expect(rebased?.orphaned).toBeUndefined();
		expect(rebased?.digest).toBe(value.digest);
	});

	/**
	 * An epoch rotation throws away the history the position was expressed in,
	 * so the digest is the only way back. It works because the content is the
	 * same even though nothing else is.
	 */
	it("recovers an anchor across an epoch rotation, by digest", async () => {
		let subject = await plan();
		let value = anchor(subject.document, 2);

		let rotated = await room.replace(room.project(subject.document));
		expect(rotated.epoch).not.toBe(subject.document.epoch);

		let [rebased] = room.rebase(rotated, [value]);

		expect(rebased?.orphaned).toBeUndefined();
		expect(rebased?.epoch).toBe(rotated.epoch);
		expect(room.resolveAnchor(rotated, rebased!)).toBeDefined();
	});

	it("orphans an anchor whose block is gone rather than guessing", async () => {
		let subject = await plan();
		let value = anchor(subject.document, 2);

		edit.apply(subject, 1, [{ op: "delete", index: 2 }]);
		let [rebased] = room.rebase(subject.document, [value]);

		expect(rebased?.orphaned).toBe(true);
	});

	/**
	 * Two identical paragraphs give no way to tell which was meant, so neither
	 * is chosen. Pointing a decision at the wrong passage is worse than
	 * admitting the link is lost.
	 */
	it("orphans rather than choose between identical blocks", async () => {
		let subject = await plan("# Title\n\nSame.\n\nOther.\n");
		let value = anchor(subject.document, 1);

		// Make a second block identical to the anchored one, then rotate so the
		// position cannot resolve and only the digest is left.
		edit.apply(subject, 1, [{ op: "replace", index: 2, source: "Same.\n" }]);
		let rotated = await room.replace(room.project(subject.document));

		let [rebased] = room.rebase(rotated, [value]);
		expect(rebased?.orphaned).toBe(true);
	});

	it("leaves an already-orphaned anchor orphaned, on the current epoch", async () => {
		let subject = await plan();
		let orphan: Plan.Anchor = {
			epoch: "gone",
			position: "",
			digest: "sha256:nothing",
			orphaned: true,
		};

		let [rebased] = room.rebase(subject.document, [orphan]);

		expect(rebased?.orphaned).toBe(true);
		expect(rebased?.epoch).toBe(subject.document.epoch);
	});
});

describe("digests", () => {
	it("give every block a stable hash of its canonical source", async () => {
		let subject = await plan();
		let first = room.digests(subject.document);
		let second = room.digests(subject.document);

		expect(first).toEqual(second);
		expect(first).toHaveLength(4);
		expect(new Set(first).size).toBe(4);
	});
});

/**
 * Turning what a batch did into places a browser can find.
 *
 * The edit engine reports indices, because only it knows what the operations
 * meant; the anchors are minted afterwards, because only the live document
 * knows where a block sits in the collaborative history. These pin the join
 * between the two — an off-by-one here would mark the wrong prose, and mark it
 * plausibly enough that nobody would question it.
 */
describe("pointing at what an edit did", () => {
	/**
	 * The block an anchor names, as the text in it.
	 *
	 * Both halves of the anchor have to agree for this to answer: the position
	 * has to still resolve in this history, and the digest has to still match a
	 * block. An anchor minted against the wrong index fails the second even
	 * though it passes the first, which is the off-by-one worth catching.
	 */
	function block(subject: Room, value: Plan.Anchor): string | undefined {
		if (!room.resolveAnchor(subject.document, value)) return undefined;
		let index = room.digests(subject.document).indexOf(value.digest);
		return index < 0 ? undefined : edit.outline(subject)[index]?.preview;
	}

	it("anchors a written block to the block that was written", async () => {
		let subject = await plan();
		let outcome = edit.apply(subject, 1, [{ op: "insert", index: 1, source: "Inserted.\n" }]);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		let added = outcome.changes.find(change => change.kind === "added");
		expect(added).toBeDefined();
		if (added?.kind !== "added") return;

		expect(block(subject, anchor(subject.document, added.index))).toBe("Inserted.");
	});

	it("anchors a hole to the block still beside it", async () => {
		let subject = await plan();
		let outcome = edit.apply(subject, 1, [{ op: "delete", index: 2 }]);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		let hole = outcome.changes.find(change => change.kind === "removed");
		if (hole?.kind !== "removed") throw new Error("expected a hole");

		// The paragraph that followed what went, which is now in its place.
		expect(hole.at.side).toBe("before");
		expect(block(subject, anchor(subject.document, hole.at.index)))
			.toBe("The third paragraph.");
		expect(hole.blocks).toEqual([{ type: "paragraph", preview: "The second paragraph." }]);
	});

	/**
	 * The reason these are anchors rather than the indices the engine reported.
	 * Somebody typing a new block above them between the edit and the browser
	 * painting it would leave every index off by one.
	 */
	it("still names the same blocks after somebody edits above them", async () => {
		let subject = await plan();
		let outcome = edit.apply(subject, 1, [{ op: "insert", index: 1, source: "Inserted.\n" }]);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		let added = outcome.changes.find(change => change.kind === "added");
		if (added?.kind !== "added") return;

		let value = anchor(subject.document, added.index);
		subject.revision = 2;
		expect(edit.apply(subject, 2, [{ op: "insert", index: 0, source: "Above.\n" }]).ok).toBe(true);

		expect(room.resolveAnchor(subject.document, value)).toBeDefined();
		expect(block(subject, value)).toBe("Inserted.");
	});
});

/**
 * Where the agent leaves its cursor.
 *
 * At the end of what it wrote, not the start. A caret at the top of a new
 * block points at the first thing the reader already knows about and reads as
 * though the agent is about to type there — the opposite of what happened.
 *
 * Resolved through Lexical rather than inspected as a Yjs position, because
 * the only question that matters is where a browser would draw it.
 */
describe("the agent's cursor", () => {
	/** What `syncCursorPositions` would resolve the position to. */
	function caret(subject: Room, position: Y.RelativePosition) {
		let state = {
			anchorPos: position,
			focusPos: position,
			color: "",
			focusing: true,
			name: "",
			awarenessData: {},
		};

		let found: { key: string | null; offset: number } | undefined;
		subject.document.editor.getEditorState().read(() => {
			let { anchorKey, anchorOffset } = $getAnchorAndFocusForUserState(
				subject.document.binding,
				state,
			);
			found = { key: anchorKey, offset: anchorOffset };
		});
		return found!;
	}

	/** The text of the node a caret landed in, and how far into it it sits. */
	function landed(subject: Room, position: Y.RelativePosition) {
		let { key, offset } = caret(subject, position);
		let text: string | undefined;
		subject.document.editor.getEditorState().read(() => {
			text = key ? $getNodeByKey(key)?.getTextContent() : undefined;
		});
		return { text, offset };
	}

	it("sits after the last character of the block, not before the first", async () => {
		let subject = await plan();

		expect(landed(subject, room.endOf(subject.document, 1)))
			.toEqual({ text: "The first paragraph.", offset: "The first paragraph.".length });
	});

	it("is somewhere else entirely for a different block", async () => {
		let subject = await plan();

		expect(landed(subject, room.endOf(subject.document, 3)))
			.toEqual({ text: "The third paragraph.", offset: "The third paragraph.".length });
	});

	it("lands at the end of what a batch just wrote", async () => {
		let subject = await plan();
		let outcome = edit.apply(subject, 1, [
			{ op: "insert", index: 3, source: "Appended by the agent.\n" },
		]);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		let added = outcome.changes.find(change => change.kind === "added");
		if (added?.kind !== "added") throw new Error("expected a written block");

		expect(landed(subject, room.endOf(subject.document, added.index))).toEqual({
			text: "Appended by the agent.",
			offset: "Appended by the agent.".length,
		});
	});

	/** A questionnaire is a map, not a sequence; there is no inside to end at. */
	it("does not fall over on a block with no text in it", async () => {
		let subject = await plan("---\n");
		expect(() => room.endOf(subject.document, 0)).not.toThrow();
	});
});
