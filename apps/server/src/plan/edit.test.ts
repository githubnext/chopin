/**
 * Editing the plan the way an agent has to.
 *
 * An agent cannot hold a cursor, so it edits by position in the list of
 * top-level blocks. Positions move under concurrent editing, which is why a
 * batch names the revision it was written against and is refused outright if
 * the plan has moved on — a half-applied batch would be worse than none.
 */

import { beforeEach, describe, expect, it } from "bun:test";

import * as edit from "./edit";
import * as room from "./room";

import type { Plan } from "./service";

const SOURCE = `# Title

First paragraph.

Second paragraph.
`;

/** Enough of a plan for the edit engine, which only needs these three fields. */
async function plan(source = SOURCE): Promise<Plan> {
	return {
		document: await room.create(source),
		revision: 1,
		outlines: new Map(),
	} as Plan;
}

let subject: Plan;

beforeEach(async () => {
	subject = await plan();
});

describe("reading", () => {
	it("describes each top-level block with a preview and a digest", () => {
		let blocks = edit.outline(subject);

		expect(blocks.map(block => block.type)).toEqual(["heading", "paragraph", "paragraph"]);
		expect(blocks[0]?.preview).toBe("Title");
		expect(blocks[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

describe("applying a batch", () => {
	it("inserts after the block it names", () => {
		let outcome = edit.apply(subject, 1, [{ op: "insert", index: 0, source: "Inserted.\n" }]);

		expect(outcome.ok).toBe(true);
		expect(room.project(subject.document)).toBe(
			"# Title\n\nInserted.\n\nFirst paragraph.\n\nSecond paragraph.\n",
		);
	});

	it("replaces, deletes and moves", () => {
		expect(edit.apply(subject, 1, [{ op: "replace", index: 1, source: "Rewritten.\n" }]).ok)
			.toBe(true);
		expect(room.project(subject.document)).toContain("Rewritten.");

		expect(edit.apply(subject, 1, [{ op: "delete", index: 2 }]).ok).toBe(true);
		expect(room.project(subject.document)).not.toContain("Second paragraph.");

		expect(edit.apply(subject, 1, [{ op: "move", index: 0, to: 1 }]).ok).toBe(true);
		expect(room.project(subject.document)).toBe("Rewritten.\n\n# Title\n");
	});

	/**
	 * Indices are resolved against the document as it was read, so two
	 * operations in one batch cannot shift each other's targets out from under
	 * them. Without this, `delete 0` followed by `replace 1` would silently hit
	 * the wrong block.
	 */
	it("resolves every index against the revision that was read", () => {
		let outcome = edit.apply(subject, 1, [
			{ op: "delete", index: 0 },
			{ op: "replace", index: 1, source: "Replaced first paragraph.\n" },
		]);

		expect(outcome.ok).toBe(true);
		expect(room.project(subject.document))
			.toBe("Replaced first paragraph.\n\nSecond paragraph.\n");
	});

	it("mints identity for a component the agent writes without one", () => {
		let outcome = edit.apply(subject, 1, [{
			op: "insert",
			index: 0,
			source: '<Callout type="warning">\n\tMind this.\n</Callout>\n',
		}]);

		expect(outcome.ok).toBe(true);
		expect(room.project(subject.document)).toMatch(/<Callout id="[0-7][0-9A-HJKMNP-TV-Z]{25}"/);
	});
});

describe("reporting what a batch wrote", () => {
	/**
	 * Which blocks a turn authored is what lets a decision be pointed at the
	 * prose it produced, even when the agent forgets to say so. Object identity
	 * is what tells them apart: a node carried over from the parsed base is the
	 * same object, a staged one is not.
	 */
	it("names the blocks it authored and not the ones it left alone", () => {
		let outcome = edit.apply(subject, 1, [{ op: "replace", index: 1, source: "Rewritten.\n" }]);

		expect(outcome).toMatchObject({ ok: true, touched: [1] });
	});

	it("names each of several", () => {
		let outcome = edit.apply(subject, 1, [
			{ op: "replace", index: 1, source: "One.\n" },
			{ op: "replace", index: 2, source: "Two.\n" },
		]);

		expect(outcome).toMatchObject({ ok: true, touched: [1, 2] });
	});

	it("names an insertion where it landed", () => {
		let outcome = edit.apply(subject, 1, [{ op: "insert", index: 0, source: "Added.\n" }]);

		expect(outcome).toMatchObject({ ok: true, touched: [1] });
	});

	/** Moving a block writes nothing: it is the same prose, further down. */
	it("names nothing when a batch only moves blocks", () => {
		let outcome = edit.apply(subject, 1, [{ op: "move", index: 2, to: 0 }]);

		expect(outcome).toMatchObject({ ok: true, touched: [] });
	});

	it("names nothing when a batch only deletes", () => {
		let outcome = edit.apply(subject, 1, [{ op: "delete", index: 2 }]);

		expect(outcome).toMatchObject({ ok: true, touched: [] });
	});
});

describe("refusing a batch", () => {
	it("refuses one aimed at a revision that has moved, and says what changed", () => {
		let outcome = edit.apply(subject, 0, [{ op: "delete", index: 0 }]);

		expect(outcome).toMatchObject({ ok: false, reason: "stale", revision: 1 });
		// Untouched.
		expect(room.project(subject.document)).toBe(SOURCE);
	});

	it("refuses a batch that targets one block twice", () => {
		let outcome = edit.apply(subject, 1, [
			{ op: "replace", index: 1, source: "One.\n" },
			{ op: "delete", index: 1 },
		]);

		expect(outcome).toMatchObject({ ok: false, reason: "invalid" });
		expect(room.project(subject.document)).toBe(SOURCE);
	});

	/**
	 * `<script>` is perfectly good MDX and entirely outside this dialect.
	 * Parsing proves only the former, so the assembled result is validated
	 * before it goes anywhere near the live document.
	 */
	it("refuses content that parses but is not in the dialect", () => {
		let outcome = edit.apply(subject, 1, [{
			op: "insert",
			index: 0,
			source: "<script>alert(1)</script>\n",
		}]);

		expect(outcome).toMatchObject({ ok: false, reason: "invalid" });
		expect(room.project(subject.document)).toBe(SOURCE);
	});

	it("refuses to leave the plan empty", () => {
		let outcome = edit.apply(subject, 1, [
			{ op: "delete", index: 0 },
			{ op: "delete", index: 1 },
			{ op: "delete", index: 2 },
		]);

		expect(outcome).toMatchObject({ ok: false, reason: "invalid" });
	});

	/**
	 * A model that copies a block it read copies the id with it, and durable
	 * state hangs off that id. Two blocks claiming one is worse than refusing.
	 */
	it("refuses a duplicated component id", async () => {
		let withCallout = await plan(
			'<Callout id="01K0N4TR8K7JGM4R1J7PW4R8YJ" type="note">\n\tOne.\n</Callout>\n',
		);
		let outcome = edit.apply(withCallout, 1, [{
			op: "insert",
			index: 0,
			source: '<Callout id="01K0N4TR8K7JGM4R1J7PW4R8YJ" type="note">\n\tTwo.\n</Callout>\n',
		}]);

		expect(outcome).toMatchObject({ ok: false, reason: "invalid" });
		if (outcome.ok) return;
		expect(outcome.reason === "invalid" && outcome.message).toContain("appears twice");
	});

	it("refuses to author a questionnaire, which is asked rather than written", () => {
		let outcome = edit.apply(subject, 1, [{
			op: "insert",
			index: 0,
			source: '<Questionnaire id="01K0N4TR8K7JGM4R1J7PW4R8YJ">\n\tx\n</Questionnaire>\n',
		}]);

		expect(outcome).toMatchObject({ ok: false, reason: "invalid" });
	});

	it("refuses to author a decision, which is accepted rather than written", () => {
		let outcome = edit.apply(subject, 1, [{
			op: "insert",
			index: 0,
			source: '<Decision id="01K0N4TR8K7JGM4R1J7PW4R8YJ" quote="q" by="ana" at="t">\n'
				+ '<Note by="ana" text="n" />\n</Decision>\n',
		}]);

		expect(outcome).toMatchObject({ ok: false, reason: "invalid" });
	});

	/**
	 * A decision is what the room settled, and the record it projects has no
	 * way to hear that the plan no longer shows it. `detach_question` exists
	 * because removing a questionnaire had to be deliberate; a decision is less
	 * removable than a question, not more.
	 */
	it("refuses to delete or rewrite a decision while tidying around it", async () => {
		let held = await plan();
		room.insertDecision(held.document, {
			id: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
			quote: "First paragraph.",
			by: "ana",
			at: "2026-07-28T10:14:00Z",
			notes: [{ by: "ana", text: "Tighten this." }],
		});
		let at = edit.outline(held).findIndex(block => block.type === "Decision");
		expect(at).toBeGreaterThan(-1);

		expect(edit.apply(held, 1, [{ op: "delete", index: at }]))
			.toMatchObject({ ok: false, reason: "invalid" });
		expect(edit.apply(held, 1, [{ op: "replace", index: at, source: "Gone.\n" }]))
			.toMatchObject({ ok: false, reason: "invalid" });

		// Still there, and still saying what it said.
		expect(room.project(held.document)).toContain("Tighten this.");
	});

	it("refuses an index the plan does not have", () => {
		expect(edit.apply(subject, 1, [{ op: "delete", index: 9 }]))
			.toMatchObject({ ok: false, reason: "invalid" });
	});
});

describe("reconciliation", () => {
	/**
	 * The reason an edit is reconciled rather than replacing the document:
	 * blocks the agent did not touch keep their identity, so anyone editing
	 * alongside it keeps their cursor, their selection and their undo history.
	 */
	it("leaves untouched blocks with the identity they had", () => {
		let keys = () => {
			let out: string[] = [];
			subject.document.editor.getEditorState().read(() => {
				// eslint-disable-next-line
				out = [...subject.document.editor.getEditorState()._nodeMap.keys()];
			});
			return out;
		};

		let before = keys();
		expect(edit.apply(subject, 1, [{ op: "replace", index: 2, source: "Rewritten.\n" }]).ok)
			.toBe(true);
		let after = keys();

		// The heading and first paragraph survive; only the replaced block and
		// the root differ.
		let survived = before.filter(key => after.includes(key));
		expect(survived.length).toBeGreaterThan(3);
	});

	it("produces a delta to relay, not a whole document", () => {
		let outcome = edit.apply(subject, 1, [{ op: "insert", index: 0, source: "Added.\n" }]);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.mutation).toBeDefined();
		expect(outcome.mutation!.source).toContain("Added.");
	});
});

/**
 * What a batch did, so a reader can be shown where.
 *
 * The two halves are derived differently on purpose, and the difference is
 * what these pin: identity answers what was written, and cannot be fooled;
 * the operations answer what moved or went, which identity cannot tell apart
 * from a block merely pushed down by an insert above it.
 */
describe("reporting what a batch did", () => {
	/** Every change, in the order the reader will meet them. */
	function changes(outcome: edit.Result): edit.Change[] {
		expect(outcome.ok).toBe(true);
		return outcome.ok ? outcome.changes : [];
	}

	it("reports a block it wrote, with enough of it to recognise", () => {
		let found = changes(
			edit.apply(subject, 1, [{ op: "insert", index: 0, source: "Inserted.\n" }]),
		);

		expect(found).toEqual([
			{ kind: "added", index: 1, type: "paragraph", preview: "Inserted." },
		]);
	});

	/**
	 * The case index comparison gets wrong. Everything below an insert shifts
	 * down by one, and a diff that read position as movement would light up
	 * the whole document for an edit that touched one block.
	 */
	it("does not report blocks an insert pushed down as having moved", () => {
		let found = changes(
			edit.apply(subject, 1, [{ op: "insert", index: 0, source: "Inserted.\n" }]),
		);

		expect(found.filter(change => change.kind === "moved")).toEqual([]);
	});

	it("reports a rewrite as what it wrote, and leaves no hole", () => {
		let found = changes(
			edit.apply(subject, 1, [{ op: "replace", index: 1, source: "Rewritten.\n" }]),
		);

		expect(found).toEqual([
			{ kind: "added", index: 1, type: "paragraph", preview: "Rewritten." },
		]);
	});

	it("names the hole a deletion left by the block that followed it", () => {
		let found = changes(edit.apply(subject, 1, [{ op: "delete", index: 1 }]));

		expect(found).toEqual([
			{
				kind: "removed",
				at: { index: 1, side: "before" },
				blocks: [{ type: "paragraph", preview: "First paragraph." }],
			},
		]);
	});

	it("names a hole at the end by the block before it", () => {
		let found = changes(edit.apply(subject, 1, [{ op: "delete", index: 2 }]));

		expect(found).toEqual([
			{
				kind: "removed",
				at: { index: 1, side: "after" },
				blocks: [{ type: "paragraph", preview: "Second paragraph." }],
			},
		]);
	});

	/** Three blocks deleted in a row is one hole in the prose, not three. */
	it("collapses deletions that left the same space into one hole", () => {
		let found = changes(
			edit.apply(subject, 1, [{ op: "delete", index: 1 }, { op: "delete", index: 2 }]),
		);

		expect(found).toEqual([
			{
				kind: "removed",
				at: { index: 0, side: "after" },
				blocks: [
					{ type: "paragraph", preview: "First paragraph." },
					{ type: "paragraph", preview: "Second paragraph." },
				],
			},
		]);
	});

	it("reports a move as one change, at both ends", () => {
		let found = changes(edit.apply(subject, 1, [{ op: "move", index: 0, to: 2 }]));

		expect(found).toEqual([
			{
				kind: "moved",
				index: 2,
				from: { index: 0, side: "before" },
				type: "heading",
				preview: "Title",
			},
		]);
	});

	it("reports nothing for a move that goes nowhere", () => {
		expect(changes(edit.apply(subject, 1, [{ op: "move", index: 1, to: 1 }]))).toEqual([]);
	});

	/**
	 * The exclusion that stops a hole pointing at the wrong prose.
	 *
	 * The deleted paragraph sat between the heading and the block after it,
	 * and that block is the one this batch sends to the top. Naming the hole
	 * by it would put the mark above the whole document, nowhere near where
	 * the content was, so the search has to pass over anything that vacated
	 * and settle on the heading instead.
	 */
	it("does not name a hole by a block that has itself gone elsewhere", () => {
		let found = changes(
			edit.apply(subject, 1, [{ op: "delete", index: 1 }, { op: "move", index: 2, to: 0 }]),
		);

		expect(room.project(subject.document)).toBe("Second paragraph.\n\n# Title\n");
		// The heading, which ended up last — not the paragraph now at the top.
		expect(found.find(change => change.kind === "removed"))
			.toMatchObject({ at: { index: 1, side: "after" } });
	});

	/** A document marked from end to end says nothing at all. */
	it("reports nothing when the whole plan was replaced", () => {
		expect(changes(edit.apply(subject, 1, [{ op: "replace_root", source: "# New\n" }])))
			.toEqual([]);
	});

	it("reads in document order", () => {
		let found = changes(
			edit.apply(subject, 1, [
				{ op: "insert", index: 2, source: "Last.\n" },
				{ op: "insert", index: 0, source: "Early.\n" },
			]),
		);

		expect(found.map(change => change.kind === "removed" ? change.at.index : change.index))
			.toEqual([1, 4]);
	});
});
