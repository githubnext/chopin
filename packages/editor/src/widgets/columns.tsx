import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";
import {
	$createParagraphNode,
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isRangeSelection,
} from "lexical";

import { $isColumnNode, $isColumnsNode } from "@chopin/dialect";

import type { ColumnsNode } from "@chopin/dialect";
import type { LexicalEditor, LexicalNode } from "lexical";

/** Move the authored blocks out in reading order, keeping their Lexical identities. */
export function $unwrapColumns(columns: ColumnsNode): void {
	let selection = $getSelection();
	let selectedKey = $isRangeSelection(selection) ? selection.anchor.key : undefined;
	let moved: LexicalNode[] = [];
	for (let column of columns.getChildren().filter($isColumnNode)) {
		for (let block of column.getChildren()) {
			columns.insertBefore(block);
			moved.push(block);
		}
	}
	if (!moved.length) {
		let paragraph = $createParagraphNode();
		columns.insertBefore(paragraph);
		moved.push(paragraph);
	}
	let selected = selectedKey ? $getNodeByKey(selectedKey) : null;
	if (!selected?.isAttached() || selected.getTopLevelElement() === columns) {
		moved[0].selectStart();
	}
	columns.remove();
}

function collect(editor: LexicalEditor): string[] {
	return editor.getEditorState().read(() =>
		$getRoot().getChildren().filter($isColumnsNode).map(node => node.getKey())
	);
}

export function ColumnsPlugin() {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);
	let [keys, setKeys] = useState<string[]>([]);

	useEffect(() => {
		let update = () => setKeys(collect(editor));
		update();
		return editor.registerUpdateListener(update);
	}, [editor]);

	if (disabled) return null;
	return (
		<>
			{keys.map(key => {
				let host = editor.getElementByKey(key)
					?.querySelector<HTMLElement>("[data-plan-chrome='columns']");
				if (!host) return null;
				return createPortal(
					<button
						type="button"
						contentEditable={false}
						className="plan-columns-unwrap btn btn-sm btn-ghost text-xs"
						aria-label="Unwrap columns"
						onKeyDown={event => event.stopPropagation()}
						onClick={event => {
							event.stopPropagation();
							editor.update(() => {
								let columns = $getNodeByKey(key);
								if ($isColumnsNode(columns)) $unwrapColumns(columns);
							});
						}}
					>
						Unwrap columns
					</button>,
					host,
					key,
				);
			})}
		</>
	);
}
