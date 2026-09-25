import { baseValue, changes, currentValue, gridRows, surface } from "@chopin/color";
import { currentViewport, listenToViewportChanges } from "@chopin/viewport";
import { useLayoutEffect, useRef, useState } from "react";

import { ColorPopover } from "./color-popover";
import { placePopover } from "./geometry";
import { PaletteGrid } from "./palette-grid";

import type { PaletteAction, PaletteState, Purpose, SwatchRef } from "@chopin/color";
import type { ContrastOption } from "./contrast-reader";

export type PaletteEditorProps = { state: PaletteState; dispatch(action: PaletteAction): void };

function title(ref: SwatchRef): string {
	return `${ref.hue.charAt(0).toUpperCase()}${ref.hue.slice(1)} ${ref.step}`;
}

export function contrastOptions(state: PaletteState): ContrastOption[] {
	let options: ContrastOption[] = [{
		id: "surface",
		label: state.theme === "dark" ? "Dark surface" : "Page surface",
		value: surface(state),
	}];
	for (let row of gridRows(state)) {
		for (let cell of row.cells) {
			options.push({
				id: JSON.stringify([row.name, cell.step]),
				label: title(cell.ref),
				value: cell.value,
			});
		}
	}
	return options;
}

export function PaletteEditor({ state, dispatch }: PaletteEditorProps) {
	let popover = useRef<HTMLDivElement>(null);
	let anchor = useRef<HTMLElement | null>(null);
	let [purpose, setPurpose] = useState<Purpose>("graphic");
	let [against, setAgainst] = useState("surface");
	let [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	let selected = state.selected;
	let pending = changes(state).length;

	useLayoutEffect(() => {
		if (!selected) return;
		function place() {
			let element = popover.current;
			let trigger = anchor.current;
			if (!element || !trigger) return;
			let size = { width: element.offsetWidth, height: element.offsetHeight };
			setPosition(placePopover(trigger.getBoundingClientRect(), size, currentViewport()));
		}
		place();
		return listenToViewportChanges(place, { observeDocumentScroll: true });
	}, [selected]);

	function open(ref: SwatchRef, element: HTMLElement) {
		anchor.current = element;
		dispatch({ type: "select", ref });
		if (!popover.current?.matches(":popover-open")) popover.current?.showPopover();
	}

	let value = selected && currentValue(state, selected);
	let previous = selected && baseValue(state, selected);
	return (
		<div className="cv-palette-editor">
			<PaletteGrid onActivate={open} rows={gridRows(state)} />
			{pending > 0 && (
				<p className="cv-palette-changes">
					{pending} {pending === 1 ? "change" : "changes"} ·{" "}
					<button onClick={() => dispatch({ type: "resetAll" })} type="button">
						Discard all
					</button>
				</p>
			)}
			<div
				className="cv-palette-popover"
				onToggle={event => {
					if (event.newState !== "closed" || popover.current?.matches(":popover-open")) return;
					dispatch({ type: "select", ref: null });
					anchor.current?.focus({ preventScroll: true });
				}}
				popover="auto"
				ref={popover}
				style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}
			>
				{selected && value && previous && (
					<ColorPopover
						contrast={{
							against,
							onAgainstChange: setAgainst,
							onPurposeChange: setPurpose,
							options: contrastOptions(state),
							purpose,
						}}
						onChange={next => dispatch({ type: "edit", ref: selected, value: next })}
						previous={previous}
						title={title(selected)}
						value={value}
					/>
				)}
			</div>
		</div>
	);
}
