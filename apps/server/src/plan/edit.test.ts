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
