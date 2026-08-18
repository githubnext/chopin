import {
	canAddColumn,
	canAddRow,
	canMoveColumn,
	canMoveRow,
	canRemoveColumn,
	canRemoveRow,
	HEADER,
} from "./shape";

import type { Shape } from "./shape";

export type TouchAvailability = {
	addColumn: boolean;
	addRowAfter: boolean;
	addRowBefore: boolean;
	moveColumnLeft: boolean;
	moveColumnRight: boolean;
	moveRowDown: boolean;
	moveRowUp: boolean;
	removeColumn: boolean;
	removeRow: boolean;
};

/** Project the existing table rules onto the buttons a selected cell receives. */
export function touchAvailability(
	shape: Shape,
	row: number,
	column: number,
): TouchAvailability {
	let addRow = canAddRow(shape);
	return {
		addColumn: canAddColumn(shape),
		addRowAfter: addRow,
		addRowBefore: row !== HEADER && addRow,
		moveColumnLeft: canMoveColumn(shape, column, column - 1),
		moveColumnRight: canMoveColumn(shape, column, column + 1),
		moveRowDown: canMoveRow(shape, row, row + 1),
		moveRowUp: canMoveRow(shape, row, row - 1),
		removeColumn: canRemoveColumn(shape, column),
		removeRow: canRemoveRow(shape, row),
	};
}
