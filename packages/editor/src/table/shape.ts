/**
 * What a table is allowed to become.
 *
 * Every predicate here is asked *before* the document is touched, because the
 * alternative is worse than a disabled button. An edit past the dialect's
 * limits applies locally, syncs cleanly, and is then refused by the server —
 * which cannot undo a Yjs transaction, so it rebuilds the room under a fresh
 * epoch and everybody in it loses their undo history and their cursors. A
 * control that goes grey at a hundred rows costs one person one row.
 *
 * Kept free of Lexical so the rules can be tested as arithmetic, which is what
 * they are.
 */

import { limits } from "@chopin/dialect";

/** A table's dimensions, as everything here needs them. */
export type Shape = {
	/** Every row, the header included. */
	rows: number;
	columns: number;
	/**
	 * False when any cell spans more than one row or column.
	 *
	 * GFM has no way to write a merged cell, so the dialect cannot represent
	 * one and a plan should never contain one. It can still arrive by paste,
	 * and `$moveTableRow` and `$moveTableColumn` both return silently rather
	 * than reorder such a table — so this is carried through to the grips,
	 * which go inert instead of becoming drags that do nothing.
	 */
	simple: boolean;
};

/**
 * The header row.
 *
 * A GFM table has exactly one and it is always the first, so its index is a
 * constant rather than a search. Naming it is worth more than the zero it
 * stands for: most of the rules below are about it.
 */
export const HEADER = 0;

export function canAddRow({ rows }: Shape): boolean {
	return rows < limits.MAX_TABLE_ROWS;
}

export function canAddColumn({ columns }: Shape): boolean {
	return columns < limits.MAX_TABLE_COLUMNS;
}

/**
 * The header cannot be removed, but the last body row can.
 *
 * `| a |\n| - |\n` is a well-formed table with no body, it round-trips, and it
 * is what somebody clearing a table out is left holding before they refill it.
 * Refusing that would mean the only way to empty a table is to delete it.
 */
export function canRemoveRow(shape: Shape, index: number): boolean {
	return index > HEADER && index < shape.rows;
}

/** Unlike a row, the last column cannot go: a table with no columns has no GFM form. */
export function canRemoveColumn({ columns }: Shape, index: number): boolean {
	return columns > 1 && index >= 0 && index < columns;
}

/**
 * The header row does not move, in either direction.
 *
 * Nothing in the document marks a row as the header — being first is the whole
 * of what makes it one, and the column alignment hangs off its cells. So a drag
 * that moved it, or moved another row above it, would not reorder the table so
 * much as change what it claims: two rows would silently swap meaning at the
 * next save, and the alignment would go with the one that stopped being the
 * header. There is no gesture that could mean that, so there is none.
 */
export function canMoveRow(shape: Shape, from: number, to: number): boolean {
	if (!shape.simple) return false;
	if (from === to) return false;
	return from > HEADER && to > HEADER && from < shape.rows && to < shape.rows;
}

/**
 * A column moves whole, header cell included.
 *
 * Which is why this has no equivalent of the rule above: the alignment lives on
 * the header cell of the column it describes, so moving the column moves it too
 * and the table means afterwards exactly what it meant before.
 */
export function canMoveColumn(shape: Shape, from: number, to: number): boolean {
	if (!shape.simple) return false;
	if (from === to) return false;
	return from >= 0 && to >= 0 && from < shape.columns && to < shape.columns;
}
