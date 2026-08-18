import { describe, expect, it } from "bun:test";
import { limits } from "@chopin/dialect";

import { touchAvailability } from "./touch-actions";

describe("touch table action availability", () => {
	it("keeps header actions from changing which row is the header", () => {
		expect(touchAvailability({ rows: 3, columns: 2, simple: true }, 0, 0)).toMatchObject({
			addRowBefore: false,
			moveRowDown: false,
			moveRowUp: false,
			removeRow: false,
		});
	});

	it("keeps the last column and refuses moves in merged tables", () => {
		expect(touchAvailability({ rows: 3, columns: 1, simple: false }, 1, 0)).toMatchObject({
			moveColumnLeft: false,
			moveColumnRight: false,
			moveRowDown: false,
			moveRowUp: false,
			removeColumn: false,
		});
	});

	it("disables only the axis that reached its dialect limit", () => {
		expect(
			touchAvailability({ rows: limits.MAX_TABLE_ROWS, columns: 2, simple: true }, 1, 0),
		).toMatchObject({ addColumn: true, addRowAfter: false, addRowBefore: false });
		expect(
			touchAvailability({ rows: 3, columns: limits.MAX_TABLE_COLUMNS, simple: true }, 1, 0),
		).toMatchObject({ addColumn: false, addRowAfter: true, addRowBefore: true });
	});
});
