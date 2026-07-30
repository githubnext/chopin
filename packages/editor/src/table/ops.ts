/**
 * The edits a rail can make.
 *
 * All `$`-prefixed and all callable only inside an `editor.update()`, so the
 * caller decides when the update commits — the browser wants the default and a
 * headless editor has to be told `discrete`, which is the same split `convert.ts`
 * draws between `$importPlan` and `importPlan`.
 *
 * Every one of these takes a node key and resolves it here rather than a node
 * captured when the control rendered: a Lexical node is a snapshot, and between
 * the render that drew a grip and the click that used it the document may have
 * been rewritten by somebody else or by the agent.
 *
 * They are also all refusals first. `shape.ts` says what is permitted and this
 * asks it before touching anything, so a control that should have been disabled
 * still cannot produce a document the server will reject.
 */

import {
	$deleteTableColumn,
	$insertTableColumnAtNode,
	$insertTableRowAtNode,
	$isSimpleTable,
	$isTableCellNode,
	$isTableNode,
	$isTableRowNode,
	$moveTableColumn,
	$moveTableRow,
	$removeTableRowAtIndex,
} from "@lexical/table";
import { $getNodeByKey, $getState, $setState } from "lexical";
import { alignState } from "@chopin/dialect";

import {
	canAddColumn,
	canAddRow,
	canMoveColumn,
	canMoveRow,
	canRemoveColumn,
	canRemoveRow,
	HEADER,
} from "./shape";

import type { Align } from "@chopin/dialect";
import type { TableCellNode, TableNode, TableRowNode } from "@lexical/table";
import type { NodeKey } from "lexical";
import type { Shape } from "./shape";

/** A table read out of the document, with everything a rail needs to draw itself. */
export type Table = {
	key: NodeKey;
	shape: Shape;
	/** Row keys in document order, the header first. */
	rows: NodeKey[];
	/** Cell keys by row, then column. */
	cells: NodeKey[][];
	/** Per column, from the header cells. */
	align: Align[];
};

function $rowsOf(table: TableNode): TableRowNode[] {
	return table.getChildren().filter($isTableRowNode);
}

function $cellsOf(row: TableRowNode): TableCellNode[] {
	return row.getChildren().filter($isTableCellNode);
}

/** The table a key names, or nothing if it is gone or no longer one. */
function $table(key: NodeKey): TableNode | undefined {
	let node = $getNodeByKey(key);
	return $isTableNode(node) ? node : undefined;
}

/** Everything about one table, as data. */
export function $describe(table: TableNode): Table {
	let rows = $rowsOf(table);
	let cells = rows.map($cellsOf);
	let header = cells[HEADER] ?? [];

	return {
		key: table.getKey(),
		shape: {
			rows: rows.length,
			// From the header, so a ragged row cannot make the rail wider than
			// the columns the table actually has.
			columns: header.length,
			simple: $isSimpleTable(table),
		},
		rows: rows.map(row => row.getKey()),
		cells: cells.map(row => row.map(cell => cell.getKey())),
		align: header.map(cell => $getState(cell, alignState)),
	};
}

/**
 * The cell an insertion hangs off, and which side of it to insert on.
 *
 * `@lexical/table` inserts relative to a cell rather than at an index, because
 * an index is ambiguous once cells can span. Turning one into the other is the
 * only awkward part: a seam is a position *between* tracks, so it is expressed
 * as the track before it, and only the seam at the very start has none.
 */
function locate(count: number, at: number): { index: number; after: boolean } {
	return at <= 0 ? { index: 0, after: false } : { index: Math.min(at, count) - 1, after: true };
}

/** Insert a row at a seam, counting the header as row zero. */
export function $addRow(key: NodeKey, at: number): void {
	let table = $table(key);
	if (!table) return;

	let described = $describe(table);
	if (!canAddRow(described.shape)) return;

	// Never above the header: a new row inserted before it would become the
	// header at the next save, taking the column alignment with it.
	let { after, index } = locate(described.shape.rows, Math.max(at, HEADER + 1));
	let cell = $getNodeByKey(described.cells[index]?.[0] ?? "");
	if ($isTableCellNode(cell)) $insertTableRowAtNode(cell, after);
}

/** Insert a column at a seam. */
export function $addColumn(key: NodeKey, at: number): void {
	let table = $table(key);
	if (!table) return;

	let described = $describe(table);
	if (!canAddColumn(described.shape)) return;

	let { after, index } = locate(described.shape.columns, at);
	let cell = $getNodeByKey(described.cells[HEADER]?.[index] ?? "");
	// `shouldSetSelection: false`. Adding a column is a change to the shape of
	// the table, not a request to go and edit the new cells, and the caret is
	// very likely in one of the old ones with a half-typed word in it. Moving
	// it there would lose the word and the place at once.
	if ($isTableCellNode(cell)) $insertTableColumnAtNode(cell, after, false);
}

export function $removeRow(key: NodeKey, index: number): void {
	let table = $table(key);
	if (!table) return;
	if (!canRemoveRow($describe(table).shape, index)) return;
	$removeTableRowAtIndex(table, index);
}

export function $removeColumn(key: NodeKey, index: number): void {
	let table = $table(key);
	if (!table) return;
	if (!canRemoveColumn($describe(table).shape, index)) return;
	// Deprecated upstream only because it cannot cope with merged cells, which
	// is a shape the dialect has no way to write and the unmerge transform
	// keeps out of the document.
	$deleteTableColumn(table, index);
}

export function $moveRow(key: NodeKey, from: number, to: number): void {
	let table = $table(key);
	if (!table) return;
	if (!canMoveRow($describe(table).shape, from, to)) return;
	$moveTableRow(table, from, to);
}

export function $moveColumn(key: NodeKey, from: number, to: number): void {
	let table = $table(key);
	if (!table) return;
	if (!canMoveColumn($describe(table).shape, from, to)) return;
	$moveTableColumn(table, from, to);
}

/**
 * Realign a column.
 *
 * The alignment is written to the header cell because that is the only place
 * GFM has to put it — the `| :--- |` row describes the column, not any one
 * value in it. Two people realigning different columns therefore write to
 * different nodes and do not conflict.
 */
export function $setAlign(key: NodeKey, column: number, align: Align): void {
	let table = $table(key);
	if (!table) return;

	let cell = $getNodeByKey($describe(table).cells[HEADER]?.[column] ?? "");
	if ($isTableCellNode(cell)) $setState(cell, alignState, align);
}
