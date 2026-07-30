/**
 * The rail's edits, judged by the MDX they produce.
 *
 * Asserting on canonical source rather than on the node tree is deliberate:
 * the source is what is saved, what the agent reads and what the next session
 * parses, so a change that leaves a plausible tree behind but writes the wrong
 * table is exactly the failure worth catching. It also covers the two things
 * the tree would not show — that the header row stays the header, and that a
 * column's alignment travels with it.
 *
 * It is a module identity check as well, in the way `interop.test.ts` is one
 * for the dialect. These operations reach for `@lexical/table` while the
 * document they act on was built by `@chopin/dialect`'s visitors, so a second
 * copy of the package would make every `$isTableNode` here return false and
 * every case below would go quiet rather than fail loudly. The catalog is what
 * prevents it; this is what would notice.
 */

import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { exportPlan, importPlan, limits, registry } from "@chopin/dialect";
import { $getRoot } from "lexical";
import { $isTableNode } from "@lexical/table";

import {
	$addColumn,
	$addRow,
	$describe,
	$moveColumn,
	$moveRow,
	$removeColumn,
	$removeRow,
	$setAlign,
} from "./ops";

import type { LexicalEditor, NodeKey } from "lexical";

const REGISTRY = registry();

const TABLE = "| Name | Count |\n| :--- | ----: |\n| API  |     1 |\n| Web  |     2 |\n";

function open(source: string): { editor: LexicalEditor; key: NodeKey } {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});
	importPlan(editor, source, { registry: REGISTRY });

	let key = "";
	editor.getEditorState().read(() => {
		let table = $getRoot().getChildren().find($isTableNode);
		key = table?.getKey() ?? "";
	});
	if (!key) throw new Error("no table in the source");

	return { editor, key };
}

/**
 * Run one operation and commit it.
 *
 * `discrete` because a headless editor has no DOM to reconcile against and so
 * defers an ordinary update past the read that follows it. The browser wants
 * the default, which is why the operations take the update rather than opening
 * one of their own.
 */
function apply(editor: LexicalEditor, op: () => void): void {
	editor.update(op, { discrete: true });
}

function source(editor: LexicalEditor): string {
	return exportPlan(editor, { registry: REGISTRY });
}

/** A table of the given size, so the limits can be reached without ceremony. */
function grid(rows: number, columns: number): string {
	let cells = (fill: string) => `| ${Array.from({ length: columns }, () => fill).join(" | ")} |`;
	return [
		cells("h"),
		cells("-"),
		...Array.from({ length: rows - 1 }, () => cells("x")),
	].join("\n") + "\n";
}

describe("adding a row", () => {
	it("inserts below the row a seam sits under", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $addRow(key, 2));
		expect(source(editor)).toBe(
			"| Name | Count |\n| :--- | ----: |\n| API  |     1 |\n|      |       |\n| Web  |     2 |\n",
		);
	});

	it("appends at the end of the table", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $addRow(key, 3));
		expect(source(editor)).toBe(
			"| Name | Count |\n| :--- | ----: |\n| API  |     1 |\n| Web  |     2 |\n|      |       |\n",
		);
	});

	it("cannot be pushed above the header, which would rename the columns", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $addRow(key, 0));
		// Clamped to just below the header, not inserted above it.
		expect(source(editor)).toBe(
			"| Name | Count |\n| :--- | ----: |\n|      |       |\n| API  |     1 |\n| Web  |     2 |\n",
		);
	});

	it("does not add the row that would break the dialect's limit", () => {
		let { editor, key } = open(grid(limits.MAX_TABLE_ROWS, 2));
		apply(editor, () => $addRow(key, limits.MAX_TABLE_ROWS));
		expect(shapeOf(editor, key).rows).toBe(limits.MAX_TABLE_ROWS);
	});
});

describe("adding a column", () => {
	it("inserts before the first column when the seam is at the start", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $addColumn(key, 0));
		expect(source(editor)).toBe(
			"|   | Name | Count |\n| - | :--- | ----: |\n|   | API  |     1 |\n|   | Web  |     2 |\n",
		);
	});

	it("appends at the end of the table", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $addColumn(key, 2));
		expect(source(editor)).toBe(
			"| Name | Count |   |\n| :--- | ----: | - |\n| API  |     1 |   |\n| Web  |     2 |   |\n",
		);
	});

	it("gives the new column a header cell and no alignment of its own", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $addColumn(key, 2));
		// The two existing columns keep theirs; the new one is unaligned.
		expect(shapeOf(editor, key).align).toEqual(["left", "right", null]);
	});

	it("does not add the column that would break the dialect's limit", () => {
		let { editor, key } = open(grid(2, limits.MAX_TABLE_COLUMNS));
		apply(editor, () => $addColumn(key, limits.MAX_TABLE_COLUMNS));
		expect(shapeOf(editor, key).columns).toBe(limits.MAX_TABLE_COLUMNS);
	});
});

describe("removing", () => {
	it("removes a body row", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $removeRow(key, 1));
		expect(source(editor)).toBe("| Name | Count |\n| :--- | ----: |\n| Web  |     2 |\n");
	});

	it("leaves a table with only its header when the last body row goes", () => {
		let { editor, key } = open("| Name |\n| ---- |\n| API  |\n");
		apply(editor, () => $removeRow(key, 1));
		expect(source(editor)).toBe("| Name |\n| ---- |\n");
	});

	it("refuses to remove the header row", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $removeRow(key, 0));
		expect(source(editor)).toBe(TABLE);
	});

	it("removes a column and the alignment that belonged to it", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $removeColumn(key, 0));
		expect(source(editor)).toBe("| Count |\n| ----: |\n|     1 |\n|     2 |\n");
	});

	it("refuses to remove the last column, which has no GFM form", () => {
		let { editor, key } = open("| Name |\n| ---- |\n| API  |\n");
		apply(editor, () => $removeColumn(key, 0));
		expect(source(editor)).toBe("| Name |\n| ---- |\n| API  |\n");
	});
});

describe("reordering", () => {
	it("moves a body row down", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $moveRow(key, 1, 2));
		expect(source(editor)).toBe(
			"| Name | Count |\n| :--- | ----: |\n| Web  |     2 |\n| API  |     1 |\n",
		);
	});

	it("refuses to move the header row, or anything above it", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $moveRow(key, 0, 2));
		apply(editor, () => $moveRow(key, 2, 0));
		expect(source(editor)).toBe(TABLE);
	});

	it("moves a column and carries its alignment with it", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $moveColumn(key, 0, 1));
		// `Name` was left-aligned and `Count` right; both stay that way after
		// the swap, because the alignment lives on the header cell that moved.
		expect(source(editor)).toBe(
			"| Count | Name |\n| ----: | :--- |\n|     1 | API  |\n|     2 | Web  |\n",
		);
	});
});

describe("alignment", () => {
	it("realigns a column through its header cell", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $setAlign(key, 1, "center"));
		expect(source(editor)).toBe(
			"| Name | Count |\n| :--- | :---: |\n| API  |   1   |\n| Web  |   2   |\n",
		);
	});

	it("clears an alignment back to the default the source omits", () => {
		let { editor, key } = open(TABLE);
		apply(editor, () => $setAlign(key, 0, null));
		expect(source(editor)).toBe(
			"| Name | Count |\n| ---- | ----: |\n| API  |     1 |\n| Web  |     2 |\n",
		);
	});
});

describe("a table that is no longer there", () => {
	it("is edited by nobody", () => {
		// Between the render that drew a grip and the click that used it, the
		// agent may have rewritten the block out from under it.
		let { editor, key } = open(TABLE);
		editor.update(() => {
			$getRoot().clear();
		}, { discrete: true });

		expect(() => apply(editor, () => $addRow(key, 1))).not.toThrow();
		expect(() => apply(editor, () => $removeColumn(key, 0))).not.toThrow();
		expect(() => apply(editor, () => $moveRow(key, 1, 2))).not.toThrow();
		expect(() => apply(editor, () => $setAlign(key, 0, "center"))).not.toThrow();

		// And nothing was conjured back into existence to be edited.
		expect(editor.getEditorState().read(() => $getRoot().getChildren().some($isTableNode)))
			.toBe(false);
	});
});

function shapeOf(editor: LexicalEditor, key: NodeKey) {
	let out = { rows: 0, columns: 0, align: [] as unknown[] };
	editor.getEditorState().read(() => {
		let table = $getRoot().getChildren().find($isTableNode);
		if (!table || table.getKey() !== key) return;
		let described = $describe(table);
		out = {
			rows: described.shape.rows,
			columns: described.shape.columns,
			align: described.align,
		};
	});
	return out;
}
