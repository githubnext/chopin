import { contrast, format, sharedSteps, toHex } from "@chopin/color";
import { useRef, useState } from "react";

import { gridMove } from "./geometry";

import type { GridRow, Oklch, SwatchRef } from "@chopin/color";
import type { GridPosition } from "./geometry";
import type { CSSProperties } from "react";

export type PaletteGridProps = {
	rows: readonly GridRow[];
	onActivate(ref: SwatchRef, anchor: HTMLElement): void;
};

let black: Oklch = { l: 0, c: 0, h: 0 };
let white: Oklch = { l: 1, c: 0, h: 0 };

function label(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

export function PaletteGrid({ rows, onActivate }: PaletteGridProps) {
	let buttons = useRef(new Map<string, HTMLButtonElement>());
	let [focus, setFocus] = useState<{ position: GridPosition; selectedKey: string | null } | null>(
		null,
	);
	let steps = sharedSteps(rows);
	let firstRow = rows.findIndex(row => row.cells.length > 0);
	let lastRow = rows.findLastIndex(row => row.cells.length > 0);
	let selected: GridPosition | null = null;
	let selectedKey: string | null = null;
	for (let row = 0; row < rows.length; row++) {
		let index = rows[row].cells.findIndex(cell => cell.selected);
		if (index >= 0) {
			selected = { row, index };
			selectedKey = JSON.stringify([
				rows[row].cells[index].ref.hue,
				rows[row].cells[index].ref.step,
			]);
			break;
		}
	}
	let position = focus?.selectedKey === selectedKey ? focus.position : selected;
	let active = position && rows[position.row]?.cells.length
		? {
			row: position.row,
			index: Math.min(position.index, rows[position.row].cells.length - 1),
		}
		: firstRow >= 0
		? { row: firstRow, index: 0 }
		: null;
	let lengths = rows.map(row => row.cells.length);
	let rampWidth = Math.max(0, ...lengths) * 32;

	return (
		<div
			className="cv-palette-grid"
			style={{ "--cv-ramp-min-width": `${rampWidth}px` } as CSSProperties}
		>
			{steps && (
				<div aria-hidden="true" className="cv-palette-grid-steps">
					<span />
					<div className="cv-palette-grid-step-cells">
						{steps.map((step, index) => <span key={`${step}:${index}`}>{step}</span>)}
					</div>
				</div>
			)}
			{rows.map((row, rowIndex) => (
				<div
					aria-label={label(row.name)}
					className="cv-palette-grid-row"
					key={row.name}
					role="group"
				>
					<span className="cv-palette-grid-name">{row.name}</span>
					{row.cells.length
						? (
							<div
								className="cv-palette-grid-cells"
								data-first={rowIndex === firstRow || undefined}
								data-last={rowIndex === lastRow || undefined}
							>
								{row.cells.map((cell, index) => {
									let position = { row: rowIndex, index };
									let key = `${rowIndex}:${index}`;
									let name = label(row.name);
									return (
										<button
											aria-label={`${name} ${cell.step}, ${format(cell.value, "oklch")}${
												cell.edited ? ", edited" : ""
											}`}
											aria-pressed={cell.selected}
											className="cv-palette-grid-swatch"
											data-dot={contrast(cell.value, black) >= contrast(cell.value, white)
												? "dark"
												: "light"}
											data-edited={cell.edited || undefined}
											key={cell.step}
											onClick={event => {
												setFocus({ position, selectedKey });
												onActivate(cell.ref, event.currentTarget);
											}}
											onKeyDown={event => {
												let moved = gridMove(lengths, position, event.key);
												if (!moved) return;
												event.preventDefault();
												setFocus({ position: moved, selectedKey });
												buttons.current.get(`${moved.row}:${moved.index}`)?.focus();
											}}
											ref={element => {
												if (element) buttons.current.set(key, element);
												else buttons.current.delete(key);
											}}
											style={{ background: toHex(cell.value) }}
											tabIndex={active?.row === rowIndex && active.index === index ? 0 : -1}
											title={`${row.name} ${cell.step}`}
											type="button"
										/>
									);
								})}
							</div>
						)
						: <span className="cv-palette-grid-empty">No colors</span>}
				</div>
			))}
		</div>
	);
}
