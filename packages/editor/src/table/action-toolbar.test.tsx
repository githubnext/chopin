import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TableActionToolbarView } from "./action-toolbar";

import type { TableActionGroup } from "./action-toolbar";
import type { Table } from "./ops";

let table: Table = {
	align: [null, "right"],
	cells: [["a", "b"], ["c", "d"]],
	key: "table",
	rows: ["header", "body"],
	shape: { columns: 2, rows: 2, simple: true },
};

function render(group: TableActionGroup, placed = true) {
	return renderToStaticMarkup(
		createElement(TableActionToolbarView, {
			act: () => {},
			column: 0,
			group,
			onGroup: () => {},
			position: placed ? { left: 8, maxHeight: 240, top: 400, width: 320 } : undefined,
			row: 1,
			table,
		}),
	);
}

describe("TableActionToolbarView", () => {
	it("shows the chosen group's actions for the selected cell", () => {
		let add = render("add");
		expect(add).toContain('aria-label="Add table actions"');
		expect(add).toContain("Add row before");
		expect(add).toContain('aria-label="Align column 1, currently default"');
		expect(add).toContain("left:8px;top:400px;max-height:240px;width:320px");

		let remove = render("remove");
		expect(remove).toContain("Remove row 2");
		expect(remove).toContain("Remove column 1");
	});

	it("hides an unplaced dock until it has a position", () => {
		let markup = render("move", false);
		expect(markup).toContain("visibility:hidden");
		expect(markup).toContain("Move row up");
	});
});
