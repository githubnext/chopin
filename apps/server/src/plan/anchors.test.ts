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
