import { describe, expect, it } from "bun:test";
import { limits } from "@chopin/dialect";

import {
	canAddColumn,
	canAddRow,
	canMoveColumn,
	canMoveRow,
	canRemoveColumn,
	canRemoveRow,
} from "./shape";

import type { Shape } from "./shape";

function shape(rows: number, columns: number, simple = true): Shape {
	return { rows, columns, simple };
}

describe("growing a table", () => {
	it("allows a row until the dialect's limit is reached", () => {
		expect(canAddRow(shape(limits.MAX_TABLE_ROWS - 1, 3))).toBe(true);
		expect(canAddRow(shape(limits.MAX_TABLE_ROWS, 3))).toBe(false);
	});

	it("allows a column until the dialect's limit is reached", () => {
		expect(canAddColumn(shape(3, limits.MAX_TABLE_COLUMNS - 1))).toBe(true);
		expect(canAddColumn(shape(3, limits.MAX_TABLE_COLUMNS))).toBe(false);
	});
});

describe("shrinking a table", () => {
	it("refuses to remove the header row", () => {
		expect(canRemoveRow(shape(4, 3), 0)).toBe(false);
		expect(canRemoveRow(shape(4, 3), 1)).toBe(true);
	});

	it("removes the last body row, leaving a table with only a header", () => {
		// `| a |\n| - |\n` is well formed and round-trips, so emptying a table
		// must not require deleting it.
		expect(canRemoveRow(shape(2, 3), 1)).toBe(true);
	});

	it("refuses to remove the last column", () => {
		expect(canRemoveColumn(shape(3, 2), 0)).toBe(true);
		expect(canRemoveColumn(shape(3, 1), 0)).toBe(false);
	});
});

describe("reordering", () => {
	it("moves a body row", () => {
		expect(canMoveRow(shape(4, 2), 1, 3)).toBe(true);
	});

	it("will not move the header row, or move anything above it", () => {
		expect(canMoveRow(shape(4, 2), 0, 2)).toBe(false);
		expect(canMoveRow(shape(4, 2), 2, 0)).toBe(false);
	});

	it("moves any column, header included, because alignment travels with it", () => {
		expect(canMoveColumn(shape(4, 3), 0, 2)).toBe(true);
		expect(canMoveColumn(shape(4, 3), 2, 0)).toBe(true);
	});

	it("does not reorder a table with merged cells", () => {
		// `$moveTableRow` and `$moveTableColumn` return silently on one of
		// these, so a grip that offered the drag would do nothing at all.
		expect(canMoveRow(shape(4, 3, false), 1, 2)).toBe(false);
		expect(canMoveColumn(shape(4, 3, false), 0, 2)).toBe(false);
	});

	it("treats a drop where the track already is as no move", () => {
		expect(canMoveRow(shape(4, 2), 2, 2)).toBe(false);
		expect(canMoveColumn(shape(4, 3), 1, 1)).toBe(false);
	});
});
