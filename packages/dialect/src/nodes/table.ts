/**
 * Native collaborative tables.
 *
 * MDXEditor's bundled table plugin stores an entire table as one MDAST object on
 * a single decorator node, so concurrent edits to different cells overwrite each
 * other. Plans use the stock `@lexical/table` nodes instead: rows, cells and
 * their text are ordinary Lexical children, which Yjs merges per cell.
 *
 * Column alignment lives in `NodeState` on each header cell — Yjs syncs node
 * state correctly, and keeping it per column means two people realigning
 * different columns do not conflict.
 */

import {
	$createTableCellNode,
	$createTableNode,
	$createTableRowNode,
	$isTableNode,
	TableCellHeaderStates,
	TableCellNode,
	TableNode,
	TableRowNode,
} from "@lexical/table";
import { $createParagraphNode, $getState, $isParagraphNode, $setState, createState } from "lexical";

import type { LexicalExportVisitor, MdastImportVisitor } from "@mdxeditor/editor";
import type { ElementNode } from "lexical";
import type * as Mdast from "mdast";

/** How a column's text is aligned; `null` is the default the source omits. */
export type Align = Mdast.AlignType;

const ALIGNMENTS = new Set(["left", "center", "right"]);

function parseAlign(value: string | undefined): Align {
	return value && ALIGNMENTS.has(value) ? (value as Align) : null;
}

/** Per-column alignment, stored on the header cell of that column. */
export const alignState = createState("plan-align", {
	parse: (value: unknown) => parseAlign(typeof value === "string" ? value : undefined),
});

export const TABLE_NODES = [TableNode, TableRowNode, TableCellNode];

export const MdastTableVisitor: MdastImportVisitor<Mdast.Table> = {
	testNode: "table",
	visitNode({ mdastNode, lexicalParent, actions }) {
		let table = $createTableNode();

		mdastNode.children.forEach((row, rowIndex) => {
			let rowNode = $createTableRowNode();

			row.children.forEach((cell, columnIndex) => {
				let header = rowIndex === 0;
				let cellNode = $createTableCellNode(
					header ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS,
				);

				if (header) {
					$setState(cellNode, alignState, mdastNode.align?.[columnIndex] ?? null);
				}

				// mdast cells hold phrasing content; Lexical cells need a block child.
				let paragraph = $createParagraphNode();
				cellNode.append(paragraph);
				rowNode.append(cellNode);
				actions.visitChildren(cell, paragraph);
			});

			table.append(rowNode);
		});

		(lexicalParent as ElementNode).append(table);
	},
};

export const LexicalTableVisitor: LexicalExportVisitor<TableNode, Mdast.Table> = {
	testLexicalNode: $isTableNode,
	visitLexicalNode({ lexicalNode, mdastParent, actions }) {
		let rows = lexicalNode.getChildren().filter(child => child instanceof TableRowNode);
		let header = rows[0]?.getChildren().filter(child => child instanceof TableCellNode) ?? [];

		let table: Mdast.Table = {
			type: "table",
			align: header.map(cell => $getState(cell, alignState)),
			children: [],
		};
		actions.appendToParent(mdastParent, table);

		for (let row of rows) {
			let mdastRow: Mdast.TableRow = { type: "tableRow", children: [] };
			actions.appendToParent(table, mdastRow);

			for (let cell of row.getChildren()) {
				if (!(cell instanceof TableCellNode)) continue;

				let mdastCell: Mdast.TableCell = { type: "tableCell", children: [] };
				actions.appendToParent(mdastRow, mdastCell);

				// Unwrap the block children so the cell carries phrasing directly.
				for (let child of cell.getChildren()) {
					if ($isParagraphNode(child)) {
						actions.visitChildren(child as never, mdastCell);
					} else {
						actions.visit(child, mdastCell);
					}
				}
			}
		}
	},
};
