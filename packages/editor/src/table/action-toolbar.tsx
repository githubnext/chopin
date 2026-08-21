/** Reachable table actions for compact and coarse-pointer layouts. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	$getTableCellNodeFromLexicalNode,
	$getTableColumnIndexFromTableCellNode,
	$getTableNodeFromLexicalNodeOrThrow,
	$getTableRowIndexFromTableCellNode,
} from "@lexical/table";
import { $getSelection, $isRangeSelection } from "lexical";

import { planScroller } from "../scroll";
import { placeSurface } from "../toolbar/placement";
import { editorSurfaceViewport, listenToEditorGeometry } from "../toolbar/surface";
import {
	$addColumn,
	$addRow,
	$describe,
	$moveColumn,
	$moveRow,
	$removeColumn,
	$removeRow,
	$setAlign,
} from "./ops";
import { alignmentLabel, nextAlign } from "./alignment";
import { touchAvailability } from "./touch-actions";

import type { LexicalEditor, NodeKey } from "lexical";
import type { SurfacePlacement } from "../toolbar/placement";
import type { Table } from "./ops";

type SelectedCell = { cell: NodeKey; column: number; row: number; table: Table };
type DockPlacement = SurfacePlacement & { width: number };
type ActionGroup = "add" | "move" | "remove";

export function TableActionToolbar(
	{ editor, disabled }: { editor: LexicalEditor; disabled?: boolean },
) {
	let [selected, setSelected] = useState<SelectedCell>();
	let [position, setPosition] = useState<DockPlacement>();
	let [group, setGroup] = useState<ActionGroup>("add");
	let surface = useRef<HTMLDivElement>(null);

	let sync = useCallback(() => {
		if (disabled) return setSelected(undefined);
		editor.getEditorState().read(() => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) return setSelected(undefined);
			let cell = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
			if (!cell) return setSelected(undefined);
			let table = $getTableNodeFromLexicalNodeOrThrow(cell);
			setSelected({
				cell: cell.getKey(),
				column: $getTableColumnIndexFromTableCellNode(cell),
				row: $getTableRowIndexFromTableCellNode(cell),
				table: $describe(table),
			});
		});
	}, [disabled, editor]);

	useEffect(() => {
		sync();
		let off = editor.registerUpdateListener(sync);
		let root = editor.getRootElement();
		let frame = 0;
		let afterPointer = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(sync);
		};
		root?.addEventListener("pointerup", afterPointer);
		root?.addEventListener("focusin", afterPointer);
		return () => {
			cancelAnimationFrame(frame);
			off();
			root?.removeEventListener("pointerup", afterPointer);
			root?.removeEventListener("focusin", afterPointer);
		};
	}, [editor, sync]);

	let place = useCallback(() => {
		let element = surface.current;
		let cell = selected && editor.getElementByKey(selected.cell);
		if (!element || !cell) return;
		let viewport = editorSurfaceViewport(editor);
		let width = Math.max(0, viewport.width - 16);
		let bottom = viewport.top + viewport.height;
		let next = placeSurface(
			{ left: viewport.left, right: viewport.left, top: bottom, bottom, width: 0, height: 0 },
			{ width, height: element.offsetHeight },
			viewport,
		);
		let dock = { ...next, width };
		setPosition(current =>
			current?.left === dock.left && current.top === dock.top
				&& current.maxHeight === dock.maxHeight && current.width === dock.width
				? current
				: dock
		);
		let cellBox = cell.getBoundingClientRect();
		if (cellBox.bottom > dock.top - 8 || cellBox.top < viewport.top + 8) {
			cell.scrollIntoView({ block: "center", inline: "nearest" });
		}
	}, [editor, selected]);

	useLayoutEffect(place, [group, place]);

	useEffect(() => {
		if (!selected) return;
		return listenToEditorGeometry(editor, place);
	}, [place, selected]);

	useLayoutEffect(() => {
		if (!selected) return;
		let element = surface.current;
		let scroller = planScroller(editor.getRootElement());
		if (!element || !scroller) return;
		let previous = scroller.style.scrollPaddingBottom;
		scroller.style.scrollPaddingBottom = `${element.offsetHeight + 16}px`;
		return () => {
			scroller.style.scrollPaddingBottom = previous;
		};
	}, [editor, group, selected]);

	if (disabled || !selected) return null;

	let { column, row, table } = selected;
	let act = (op: () => void) => editor.update(op);
	let align = table.align[column] ?? null;
	let button = "plan-table-action";
	let available = touchAvailability(table.shape, row, column);
	let show = (next: ActionGroup) => setGroup(next);

	return (
		<div
			aria-label="Table actions"
			className="plan-table-action-toolbar"
			contentEditable={false}
			onMouseDown={event => event.preventDefault()}
			ref={surface}
			role="toolbar"
			style={position
				? {
					left: position.left,
					top: position.top,
					maxHeight: position.maxHeight,
					width: position.width,
				}
				: { left: 8, top: 8, visibility: "hidden" }}
		>
			<div className="plan-table-action-groups">
				<button
					aria-expanded={group === "add"}
					className={button}
					onClick={() => show("add")}
					type="button"
				>
					Add
				</button>
				<button
					aria-expanded={group === "remove"}
					className={button}
					onClick={() => show("remove")}
					type="button"
				>
					Remove
				</button>
				<button
					aria-expanded={group === "move"}
					className={button}
					onClick={() => show("move")}
					type="button"
				>
					Move
				</button>
				<button
					aria-label={`Align column ${column + 1}, currently ${alignmentLabel(align)}`}
					className={button}
					onClick={() => act(() => $setAlign(table.key, column, nextAlign(align)))}
					type="button"
				>
					Align
				</button>
			</div>

			{group === "add" && (
				<div aria-label="Add table actions" className="plan-table-action-panel" role="group">
					<button
						className={button}
						disabled={!available.addRowBefore}
						onClick={() =>
							act(() =>
								$addRow(table.key, row)
							)}
						type="button"
					>
						Add row before
					</button>
					<button
						className={button}
						disabled={!available.addRowAfter}
						onClick={() => act(() => $addRow(table.key, row + 1))}
						type="button"
					>
						Add row after
					</button>
					<button
						className={button}
						disabled={!available.addColumn}
						onClick={() => act(() => $addColumn(table.key, column))}
						type="button"
					>
						Add column before
					</button>
					<button
						className={button}
						disabled={!available.addColumn}
						onClick={() => act(() => $addColumn(table.key, column + 1))}
						type="button"
					>
						Add column after
					</button>
				</div>
			)}

			{group === "remove" && (
				<div aria-label="Remove table actions" className="plan-table-action-panel" role="group">
					<button
						className={button}
						disabled={!available.removeRow}
						onClick={() =>
							act(() =>
								$removeRow(table.key, row)
							)}
						type="button"
					>
						Remove row {row + 1}
					</button>
					<button
						className={button}
						disabled={!available.removeColumn}
						onClick={() => act(() => $removeColumn(table.key, column))}
						type="button"
					>
						Remove column {column + 1}
					</button>
				</div>
			)}

			{group === "move" && (
				<div aria-label="Move table actions" className="plan-table-action-panel" role="group">
					<button
						className={button}
						disabled={!available.moveRowUp}
						onClick={() =>
							act(() =>
								$moveRow(table.key, row, row - 1)
							)}
						type="button"
					>
						Move row up
					</button>
					<button
						className={button}
						disabled={!available.moveRowDown}
						onClick={() => act(() => $moveRow(table.key, row, row + 1))}
						type="button"
					>
						Move row down
					</button>
					<button
						className={button}
						disabled={!available.moveColumnLeft}
						onClick={() => act(() => $moveColumn(table.key, column, column - 1))}
						type="button"
					>
						Move column left
					</button>
					<button
						className={button}
						disabled={!available.moveColumnRight}
						onClick={() => act(() => $moveColumn(table.key, column, column + 1))}
						type="button"
					>
						Move column right
					</button>
				</div>
			)}
		</div>
	);
}
