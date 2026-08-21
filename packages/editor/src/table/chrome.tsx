/** One responsive policy for every piece of table editing chrome. */

import { useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";

import { COARSE_POINTER_QUERY, PRIMARY_COARSE_POINTER_QUERY } from "../pointer";
import { TableActionToolbar } from "./action-toolbar";
import { TableRails } from "./rails";
import { useTableSupport } from "./support";

import type { RailMode } from "./rails";

const COMPACT_VIEWPORT_QUERY = "(max-width: 40rem)";

type TableChromeMode = "coarse" | "compact" | "full" | "hybrid";

function readMode(
	compact: Pick<MediaQueryList, "matches">,
	coarse: Pick<MediaQueryList, "matches">,
	primaryCoarse: Pick<MediaQueryList, "matches">,
): TableChromeMode {
	if (primaryCoarse.matches) return "coarse";
	if (compact.matches) return "compact";
	return coarse.matches ? "hybrid" : "full";
}

function railMode(mode: TableChromeMode): RailMode | undefined {
	if (mode === "coarse") return undefined;
	return mode === "compact" ? "grips" : "full";
}

export function TableChrome() {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);
	let tables = useTableSupport(editor);
	let [mode, setMode] = useState<TableChromeMode>(() =>
		readMode(
			matchMedia(COMPACT_VIEWPORT_QUERY),
			matchMedia(COARSE_POINTER_QUERY),
			matchMedia(PRIMARY_COARSE_POINTER_QUERY),
		)
	);

	useEffect(() => {
		let compact = matchMedia(COMPACT_VIEWPORT_QUERY);
		let coarse = matchMedia(COARSE_POINTER_QUERY);
		let primaryCoarse = matchMedia(PRIMARY_COARSE_POINTER_QUERY);
		let update = () => setMode(readMode(compact, coarse, primaryCoarse));
		compact.addEventListener("change", update);
		coarse.addEventListener("change", update);
		primaryCoarse.addEventListener("change", update);
		update();
		return () => {
			compact.removeEventListener("change", update);
			coarse.removeEventListener("change", update);
			primaryCoarse.removeEventListener("change", update);
		};
	}, []);

	let rails = railMode(mode);
	return (
		<>
			{rails ? <TableRails disabled={disabled} mode={rails} tables={tables} /> : null}
			{mode === "full" ? null : <TableActionToolbar disabled={disabled} editor={editor} />}
		</>
	);
}
