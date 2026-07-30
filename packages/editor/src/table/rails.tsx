/**
 * The rails a table is reshaped from.
 *
 * A grip per column above the table and per row beside it: the handle a drag
 * starts from, the button a row or column is removed by, and — between two of
 * them — where a new one is inserted.
 *
 * They are drawn as a fixed overlay measured from cell rectangles rather than
 * as chrome inside the node, because a `<table>` cannot contain a `<div>`. The
 * `data-plan-chrome` slot that callouts and tabs portal into is not available
 * at any price here: the browser hoists a stray div straight back out of a
 * table, so the choice is between measuring and subclassing `TableNode`. This
 * is the technique the selection bubble already uses.
 *
 * Only one table has rails at a time — whichever the pointer is over, or the
 * caret is in. Rails on every table at once would be a page of grey furniture
 * around prose that is mostly not tables.
 *
 * There is no test for this file, on purpose: it is rectangles and pointers all
 * the way down and the test runtime has no DOM. What can be decided without one
 * — which seam a drop means, what a rail's boxes are, what the table permits —
 * lives in `geometry.ts` and `shape.ts`, which are tested.
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$findTableNode,
	$isTableNode,
	registerTableCellUnmergeTransform,
	registerTablePlugin,
	registerTableSelectionObserver,
} from "@lexical/table";
import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";
import { $getRoot, $getSelection, $isElementNode, $isRangeSelection, mergeRegister } from "lexical";

import { destination, dropSeam, gripBox, seamAt, seamBox, seams } from "./geometry";
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
import { canAddColumn, canAddRow, canRemoveColumn, canRemoveRow, HEADER } from "./shape";

import type { Align } from "@chopin/dialect";
import type { ElementNode, LexicalEditor, NodeKey } from "lexical";
import type { Axis, Track } from "./geometry";
import type { Table } from "./ops";

/*
 * A rail is two lanes: grips against the table, buttons beyond them.
 *
 * They are separate because they were not, once. A cross in the middle of a
 * grip is where a drag is most naturally begun, so it swallowed the gesture it
 * was drawn beside — and only sometimes, since whether it had become live yet
 * depended on a re-render landing between the pointer arriving and the button
 * going down. Nothing in the two lanes overlaps now, so neither can take the
 * other's pointer.
 */
const GRIP = 14;
const TOOL = 14;
const DEPTH = GRIP + TOOL;

/** How much of a seam can be aimed at. */
const SEAM = 16;

/** One button in the tool lane, and how far each of a pair sits from centre. */
const BUTTON = 15;
const PAIR = 8;

/**
 * What the alignment button steps through.
 *
 * `null` first because it is what a column starts as and what the source omits;
 * stepping off the end returns to it, so the control can always be put back.
 */
const ALIGNMENTS: Align[] = [null, "left", "center", "right"];

const ALIGN_LABEL: Record<string, string> = {
	null: "default",
	left: "left",
	center: "centre",
	right: "right",
};

function nextAlign(current: Align): Align {
	let index = ALIGNMENTS.indexOf(current ?? null);
	return ALIGNMENTS[(index + 1) % ALIGNMENTS.length] ?? null;
}

/** Where a measured table is on the screen, and where its tracks are. */
type Metrics = {
	/**
	 * The table these were taken from.
	 *
	 * Carried so a render that has already switched tables can tell that the
	 * measurements have not caught up, and draw nothing for the one frame
	 * before the layout effect runs. Without it the rails appear at the last
	 * table's coordinates first, which reads as them jumping into place.
	 */
	key: NodeKey;
	left: number;
	top: number;
	width: number;
	height: number;
	columns: Track[];
	rows: Track[];
};

/** A drag in progress. */
type Drag = { axis: Axis; from: number; seam: number };

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

/**
 * Measure one table.
 *
 * Cells are found by key rather than by `querySelector`, so nothing here
 * depends on the DOM `@lexical/table` happens to build — whether rows sit
 * under a `tbody`, whether a `colgroup` comes first.
 *
 * Returns nothing when the table is not rendered, which is the case for one
 * inside a tab panel that is not the open tab.
 */
function measure(editor: LexicalEditor, table: Table): Metrics | undefined {
	let element = editor.getElementByKey(table.key);
	if (!element) return undefined;

	let frame = element.getBoundingClientRect();
	if (frame.width === 0 && frame.height === 0) return undefined;

	let box = (key: NodeKey | undefined) =>
		key ? editor.getElementByKey(key)?.getBoundingClientRect() : undefined;

	// Columns from the header row, rows from the first column: one pass along
	// each edge rather than over the whole grid.
	let columns: Track[] = [];
	for (let key of table.cells[HEADER] ?? []) {
		let rect = box(key);
		if (!rect) return undefined;
		columns.push({ start: rect.left, end: rect.right });
	}

	let rows: Track[] = [];
	for (let row of table.cells) {
		let rect = box(row[0]);
		if (!rect) return undefined;
		rows.push({ start: rect.top, end: rect.bottom });
	}

	return {
		key: table.key,
		left: frame.left,
		top: frame.top,
		width: frame.width,
		height: frame.height,
		columns,
		rows,
	};
}

/**
 * Project each column's alignment onto its cells.
 *
 * The alignment is recorded on the header cell, because the `| :--- |` row is
 * the only place GFM has to put it, but it describes the whole column — and CSS
 * cannot cascade from one cell to the others beneath it. So it is written to
 * the elements rather than the document: the same arrangement as a tab panel's
 * visibility, for the same reason, which is that how a column is drawn should
 * not be an edit.
 *
 * Re-applied on every update, because Lexical rebuilds a block's element when
 * the block changes and a style set on the old one goes with it.
 */
function paint(editor: LexicalEditor, tables: Table[]): void {
	for (let table of tables) {
		for (let row of table.cells) {
			for (let column = 0; column < row.length; column++) {
				let element = editor.getElementByKey(row[column]!);
				if (!element) continue;
				// Empty rather than "start", so clearing an alignment hands the
				// column back to the stylesheet instead of pinning it to a
				// value that would then win against any later change there.
				element.style.textAlign = table.align[column] ?? "";
			}
		}
	}
}

export function TableRails() {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);

	let [tables, setTables] = useState<Table[]>([]);
	let [active, setActive] = useState<NodeKey>();
	let [metrics, setMetrics] = useState<Metrics>();
	let [drag, setDrag] = useState<Drag>();

	/*
	 * Everything `@lexical/table` assumes is installed, and was not.
	 *
	 * Without `registerTablePlugin` a table has no keyboard navigation and none
	 * of the transforms that keep it rectangular. Without the unmerge transform
	 * a table pasted from HTML keeps its spans, which the dialect has no way to
	 * write — the export visitor ignores them, so the cells silently
	 * redistribute themselves at the next save.
	 */
	useEffect(
		() =>
			mergeRegister(
				registerTablePlugin(editor),
				registerTableSelectionObserver(editor),
				registerTableCellUnmergeTransform(editor),
			),
		[editor],
	);

	let table = tables.find(item => item.key === active);

	let remeasure = useCallback(() => {
		setMetrics(table ? measure(editor, table) : undefined);
	}, [editor, table]);

	// A ref so `schedule` can stay stable across renders while still calling
	// the current measurement, which changes whenever the active table does.
	let latest = useRef(remeasure);
	latest.current = remeasure;

	let pending = useRef(0);
	let schedule = useCallback(() => {
		cancelAnimationFrame(pending.current);
		pending.current = requestAnimationFrame(() => latest.current());
	}, []);

	useEffect(() => () => cancelAnimationFrame(pending.current), []);

	/*
	 * Read the document, and only say so when it has actually changed shape.
	 *
	 * Every keystroke fires an update, and `collect` allocates as it walks — so
	 * publishing unconditionally would re-render the rails and re-measure the
	 * table once per character typed anywhere in the plan. The measurement
	 * still has to happen on every update, because typing into a cell widens
	 * its column, but that is a rectangle read behind a frame rather than a
	 * pass over the whole tree.
	 */
	let last = useRef("");
	useEffect(() => {
		let refresh = () => {
			// An update listener that throws takes every listener after it with
			// it, including the one that syncs to Yjs. Losing the rails is the
			// cheapest outcome available and the only acceptable one.
			try {
				let next = collect(editor);
				let json = JSON.stringify(next);
				if (json !== last.current) {
					last.current = json;
					setTables(next);
					paint(editor, next);
				}
				schedule();
			} catch (err) {
				console.error("[plan] table rails could not read the document", err);
			}
		};
		refresh();
		return editor.registerUpdateListener(refresh);
	}, [editor, schedule]);

	/*
	 * Repaint the alignment after any render that could have replaced an
	 * element. Lexical rebuilds a block's element when the block changes, and
	 * an inline style set on the old one goes with it — so this cannot be left
	 * to the update above, which deliberately says nothing when the shape has
	 * not moved.
	 */
	useEffect(() => {
		try {
			paint(editor, tables);
		} catch (err) {
			console.error("[plan] column alignment could not be painted", err);
		}
	}, [editor, tables]);

	// Synchronously on a change of table, so switching between two never draws
	// one frame of rails at the other's coordinates.
	useLayoutEffect(() => {
		remeasure();
	}, [remeasure, tables]);

	/*
	 * Re-measure whenever anything could have moved the table.
	 *
	 * Rectangles go stale for more reasons than the document changing: the pane
	 * resizes, the document scrolls, and the table scrolls inside itself, which
	 * is a scroll the document never hears about. Scroll is taken on the
	 * capture phase rather than from any one element, because which element
	 * scrolls is not fixed.
	 */
	useEffect(() => {
		if (!table) return;

		window.addEventListener("scroll", schedule, { capture: true, passive: true });
		window.addEventListener("resize", schedule, { passive: true });

		let element = editor.getElementByKey(table.key);
		let observer = new ResizeObserver(schedule);
		if (element) observer.observe(element);

		return () => {
			window.removeEventListener("scroll", schedule, { capture: true });
			window.removeEventListener("resize", schedule);
			observer.disconnect();
		};
	}, [editor, table, schedule]);

	/*
	 * Which table the rails belong to.
	 *
	 * Pointer rather than caret alone, so a table can be reshaped without first
	 * clicking into it — and caret as well, so it can be reshaped with no
	 * pointer at all.
	 */
	let dragging = useRef(false);
	dragging.current = drag !== undefined;
	let leaving = useRef(0);

	let hover = useCallback((key: NodeKey | undefined) => {
		cancelAnimationFrame(leaving.current);
		if (key) return setActive(key);
		// A drag holds the pointer captured well outside the rail it started
		// from, so a leave during one is not a leave.
		if (dragging.current) return;
		/*
		 * Otherwise deferred by a frame: moving from the last cell onto a grip
		 * leaves the table before it reaches the rail, and clearing at once
		 * would take the rails out from under a pointer on its way to them.
		 * The rail's own handler cancels this before it runs.
		 */
		leaving.current = requestAnimationFrame(() => setActive(undefined));
	}, []);

	useEffect(() => {
		let root = editor.getRootElement();
		if (!root) return;

		let over = (event: PointerEvent) => {
			let target = event.target;
			if (!(target instanceof Node)) return;
			hover(tables.find(item => editor.getElementByKey(item.key)?.contains(target))?.key);
		};
		let out = () => hover(undefined);

		root.addEventListener("pointerover", over);
		root.addEventListener("pointerleave", out);
		return () => {
			root.removeEventListener("pointerover", over);
			root.removeEventListener("pointerleave", out);
		};
	}, [editor, tables, hover]);

	/*
	 * The caret, so a table can be reshaped with no pointer at all.
	 *
	 * Only when it moves into a *different* table, not on every update that
	 * happens to leave it in one. Otherwise typing in a table would keep
	 * re-asserting it against a pointer resting somewhere else, and the rails
	 * would flick between the two as long as somebody kept writing.
	 */
	let caret = useRef<NodeKey | undefined>(undefined);
	useEffect(() => {
		return editor.registerUpdateListener(() => {
			editor.getEditorState().read(() => {
				let selection = $getSelection();
				let found = $isRangeSelection(selection)
					? $findTableNode(selection.anchor.getNode())?.getKey()
					: undefined;
				if (found === caret.current) return;
				caret.current = found;
				if (found) setActive(found);
			});
		});
	}, [editor]);

	let act = useCallback((op: () => void) => editor.update(op), [editor]);

	// Metrics lag the active table by a frame; drawing against the previous
	// table's rectangles would put the rails somewhere they do not belong.
	if (disabled || !table || !metrics || metrics.key !== table.key) return null;

	return (
		<>
			<Rail
				axis="column"
				drag={drag}
				metrics={metrics}
				onAct={act}
				onDrag={setDrag}
				onHover={hover}
				table={table}
				tracks={metrics.columns}
			/>
			<Rail
				axis="row"
				drag={drag}
				metrics={metrics}
				onAct={act}
				onDrag={setDrag}
				onHover={hover}
				table={table}
				tracks={metrics.rows}
			/>
		</>
	);
}

type RailProps = {
	axis: Axis;
	drag: Drag | undefined;
	metrics: Metrics;
	onAct: (op: () => void) => void;
	onDrag: (drag: Drag | undefined) => void;
	onHover: (key: NodeKey | undefined) => void;
	table: Table;
	tracks: Track[];
};

function Rail({ axis, drag, metrics, onAct, onDrag, onHover, table, tracks }: RailProps) {
	let column = axis === "column";
	let key = table.key;
	let count = tracks.length;
	let lines = seams(tracks);
	// `Axis` is already the word for it.
	let noun = axis;

	/*
	 * The track the pointer is on, which is the only one showing a remove
	 * button.
	 *
	 * A cross against every row at once is a rail asking to be misread, and the
	 * one that matters is always the one being pointed at. Every button is
	 * rendered regardless, so they all keep their place in the tab order; this
	 * only decides which of them is drawn.
	 */
	let [under, setUnder] = useState<number>();

	/*
	 * Where the rail sits, in viewport coordinates.
	 *
	 * `overflow: hidden` so a column scrolled out of the table's own scroller
	 * takes its grip with it rather than leaving one floating past the edge.
	 * The grips lie against the table and the buttons in a lane beyond them, so
	 * the rail is as deep as the two together.
	 *
	 * Half a seam of slack at each end, because the first and last seams sit
	 * exactly on the table's edges and what is drawn on a seam straddles it:
	 * without the slack the clip that keeps a scrolled-away grip hidden cuts
	 * the outermost insert buttons in half, which are the two most likely to
	 * be wanted.
	 */
	let pad = SEAM / 2;
	let frame = column
		? {
			left: metrics.left - pad,
			top: metrics.top - DEPTH,
			width: metrics.width + pad * 2,
			height: DEPTH,
		}
		: {
			left: metrics.left - DEPTH,
			top: metrics.top - pad,
			width: DEPTH,
			height: metrics.height + pad * 2,
		};

	// Measured against the rail's own edge, slack included, so the two agree.
	let origin = column ? frame.left : frame.top;

	let mine = drag?.axis === axis ? drag : undefined;
	let at = mine ? dropSeam(axis, mine.seam) : undefined;
	let target = mine && at !== undefined ? destination(mine.from, at, count) : undefined;

	let move = (from: number, to: number) =>
		onAct(() => (column ? $moveColumn(key, from, to) : $moveRow(key, from, to)));
	let insert = (seam: number) => onAct(() => (column ? $addColumn(key, seam) : $addRow(key, seam)));
	let remove = (index: number) =>
		onAct(() => (column ? $removeColumn(key, index) : $removeRow(key, index)));

	let addable = column ? canAddColumn(table.shape) : canAddRow(table.shape);
	let removable = (index: number) =>
		column ? canRemoveColumn(table.shape, index) : canRemoveRow(table.shape, index);
	// Every column may be taken hold of; the header row may not.
	let holdable = (index: number) => table.shape.simple && (column || index > HEADER);

	return (
		<div
			className="plan-rail"
			data-plan-rail={axis}
			// Placement is measured, so it is a style rather than a class.
			style={frame}
			onPointerOver={() => onHover(key)}
			onPointerLeave={() => {
				onHover(undefined);
				setUnder(undefined);
			}}
		>
			{tracks.map((track, index) => {
				// `TOOL` is the lane offset: the grips are the lane against the
				// table, the buttons the one beyond it.
				let box = gripBox(axis, track, origin, GRIP, TOOL);
				if (!holdable(index)) {
					// The header still gets a bar, so the rail does not have a
					// gap in it where the row everybody can see plainly is.
					return <div key={index} className="plan-grip is-fixed" style={box} />;
				}
				return (
					<button
						key={index}
						type="button"
						aria-label={`Move ${noun} ${index + 1}`}
						className={`plan-grip ${mine?.from === index ? "is-held" : ""}`}
						style={box}
						title={`Drag to move this ${noun}`}
						onPointerEnter={() => setUnder(index)}
						onFocus={() => setUnder(index)}
						onPointerDown={event => {
							// Pointer capture rather than window listeners: the
							// pointer leaves the grip on any real drag, and
							// capture is what keeps the events coming without a
							// document-level subscription to tear down.
							event.currentTarget.setPointerCapture(event.pointerId);
							onDrag({ axis, from: index, seam: index });
						}}
						onPointerMove={event => {
							if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
							onDrag({
								axis,
								from: index,
								seam: seamAt(tracks, column ? event.clientX : event.clientY),
							});
						}}
						onPointerUp={event => {
							event.currentTarget.releasePointerCapture(event.pointerId);
							/*
							 * Recomputed from the event rather than read off
							 * the render that drew this handler. The last
							 * pointermove and this can fall in the same frame,
							 * and a drop that used a destination one move out
							 * of date would land a column beside where it was
							 * released with nothing anywhere to say why.
							 */
							let seam = dropSeam(
								axis,
								seamAt(tracks, column ? event.clientX : event.clientY),
							);
							let to = destination(index, seam, count);
							if (to !== undefined) move(index, to);
							onDrag(undefined);
						}}
						onPointerCancel={() => onDrag(undefined)}
						onKeyDown={event => {
							// The whole gesture from the keyboard too: a
							// reorder that is only ever a drag is a reorder
							// some people cannot perform at all.
							if (!event.metaKey && !event.ctrlKey) return;
							let back = event.key === (column ? "ArrowLeft" : "ArrowUp");
							let forward = event.key === (column ? "ArrowRight" : "ArrowDown");
							if (!back && !forward) return;
							event.preventDefault();
							move(index, index + (back ? -1 : 1));
						}}
					/>
				);
			})}

			{
				/*
				 * Removal is a sibling of the grip rather than a child of it: a
				 * button cannot contain a button, and demoting the cross to a
				 * span would cost it its place in the tab order for the sake of
				 * the nesting. It sits in the far lane, over the middle of the
				 * track it removes.
				 */
			}
			{tracks.map((track, index) => {
				let middle = (track.start + track.end) / 2;
				// A column carries two buttons, so they sit either side of the
				// track's middle rather than both on it; a row has only the one.
				let place = (offset: number) =>
					seamBox(axis, middle + (column ? offset : 0), origin, TOOL, BUTTON);
				let shown = under === index ? "" : undefined;

				return (
					<Fragment key={`tools-${index}`}>
						{column
							? (
								<button
									type="button"
									aria-label={`Align ${noun} ${index + 1}, currently ${
										ALIGN_LABEL[String(table.align[index] ?? null)]
									}`}
									className="plan-align"
									data-plan-align={table.align[index] ?? "default"}
									data-plan-shown={shown}
									style={place(-PAIR)}
									title="Change this column's alignment"
									onFocus={() => setUnder(index)}
									onPointerEnter={() => setUnder(index)}
									onClick={() =>
										onAct(() => $setAlign(key, index, nextAlign(table.align[index] ?? null)))}
								/>
							)
							: null}
						{removable(index)
							? (
								<button
									type="button"
									aria-label={`Remove ${noun} ${index + 1}`}
									className="plan-grip-remove"
									data-plan-shown={shown}
									style={place(PAIR)}
									title={`Remove this ${noun}`}
									onFocus={() => setUnder(index)}
									onPointerEnter={() => setUnder(index)}
									onClick={() => remove(index)}
								/>
							)
							: null}
					</Fragment>
				);
			})}

			{addable
				&& lines.map((line, seam) => {
					// Nothing may be inserted above the header row.
					if (!column && seam <= HEADER) return null;
					return (
						<button
							key={`insert-${seam}`}
							type="button"
							aria-label={seam === 0
								? `Insert ${noun} before the first`
								: `Insert ${noun} after ${noun} ${seam}`}
							className="plan-insert"
							style={seamBox(axis, line, origin, TOOL, SEAM)}
							title={`Insert a ${noun} here`}
							onClick={() => insert(seam)}
						/>
					);
				})}

			{target !== undefined && at !== undefined
				? (
					<div
						aria-hidden="true"
						className="plan-drop"
						style={seamBox(axis, lines[at] ?? 0, origin, GRIP, 2, TOOL)}
					/>
				)
				: null}
		</div>
	);
}
