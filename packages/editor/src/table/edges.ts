/** Marks which side of a wide table still hides columns, so the stylesheet can fade it. */

import { useEffect } from "react";

import { hiddenSides, scrollEdges } from "../widgets/tab-edges";

import type { LexicalEditor } from "lexical";
import type { Table } from "./ops";

function mark(table: HTMLElement): void {
	let more = hiddenSides(scrollEdges(table.scrollLeft, table.clientWidth, table.scrollWidth));
	if (more) table.setAttribute("data-more", more);
	else table.removeAttribute("data-more");
}

function watch(table: HTMLElement): () => void {
	let update = () => mark(table);
	update();
	let observer = new ResizeObserver(update);
	observer.observe(table);
	// The row is what grows when a column widens; the table's own box may not.
	let body = table.querySelector("tbody");
	if (body) observer.observe(body);
	table.addEventListener("scroll", update, { passive: true });
	return () => {
		observer.disconnect();
		table.removeEventListener("scroll", update);
		table.removeAttribute("data-more");
	};
}

/**
 * Keeps every table's `data-more` current.
 *
 * Tables are found again on each editor update rather than once per structural
 * change, because Lexical can replace a table's element without the table's
 * shape changing, and a listener left on the old element would go quiet.
 */
export function useTableEdges(editor: LexicalEditor, tables: Table[]): void {
	useEffect(() => {
		let watched = new Map<HTMLElement, () => void>();
		let sync = () => {
			let live = new Set<HTMLElement>();
			for (let { key } of tables) {
				let element = editor.getElementByKey(key);
				let table = element?.matches("table") ? element : element?.querySelector("table");
				if (!table) continue;
				live.add(table);
				if (!watched.has(table)) watched.set(table, watch(table));
			}
			for (let [table, stop] of watched) {
				if (live.has(table)) continue;
				stop();
				watched.delete(table);
			}
		};
		sync();
		let stop = editor.registerUpdateListener(sync);
		return () => {
			stop();
			for (let release of watched.values()) release();
		};
	}, [editor, tables]);
}
