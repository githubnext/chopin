/** Table behavior that exists independently of its responsive editing chrome. */

import { useEffect, useRef, useState } from "react";
import {
	$isTableNode,
	registerTableCellUnmergeTransform,
	registerTablePlugin,
	registerTableSelectionObserver,
} from "@lexical/table";
import { $getRoot, $isElementNode, mergeRegister } from "lexical";

import { $describe } from "./ops";

import type { ElementNode, LexicalEditor } from "lexical";
import type { Table } from "./ops";

/** Read every table out of the document. */
function collect(editor: LexicalEditor): Table[] {
	let out: Table[] = [];
	editor.getEditorState().read(() => {
		let walk = (node: ElementNode) => {
			for (let child of node.getChildren()) {
				// A table cannot nest inside a table in this dialect, but a
				// callout or a tab panel can hold one, so the walk cannot stop
				// at the top level.
				if ($isTableNode(child)) out.push($describe(child));
				else if ($isElementNode(child)) walk(child);
			}
		};
		walk($getRoot());
	});
	return out;
}

/** Project each column's recorded alignment onto its rendered cells. */
function paint(editor: LexicalEditor, tables: Table[]): void {
	for (let table of tables) {
		for (let row of table.cells) {
			for (let column = 0; column < row.length; column++) {
				let element = editor.getElementByKey(row[column]!);
				if (!element) continue;
				// Empty rather than "start", so clearing an alignment hands the
				// column back to the stylesheet.
				element.style.textAlign = table.align[column] ?? "";
			}
		}
	}
}

/** Install Lexical's table behavior and expose the tables the chrome can use. */
export function useTableSupport(editor: LexicalEditor): Table[] {
	let [tables, setTables] = useState<Table[]>([]);

	useEffect(
		() =>
			mergeRegister(
				registerTablePlugin(editor),
				registerTableSelectionObserver(editor),
				registerTableCellUnmergeTransform(editor),
			),
		[editor],
	);

	let last = useRef("");
	useEffect(() => {
		let refresh = () => {
			// An update listener that throws takes every listener after it with
			// it, including the one that syncs to Yjs. Losing table decoration is
			// the cheapest outcome available and the only acceptable one.
			try {
				let next = collect(editor);
				let json = JSON.stringify(next);
				if (json === last.current) return;
				last.current = json;
				setTables(next);
				paint(editor, next);
			} catch (err) {
				console.error("[plan] table support could not read the document", err);
			}
		};
		refresh();
		return editor.registerUpdateListener(refresh);
	}, [editor]);

	useEffect(() => {
		try {
			paint(editor, tables);
		} catch (err) {
			console.error("[plan] column alignment could not be painted", err);
		}
	}, [editor, tables]);

	return tables;
}
