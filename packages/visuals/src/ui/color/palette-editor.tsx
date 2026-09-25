import {
	baseValue,
	changes,
	currentValue,
	curveFor,
	gridRows,
	rowValues,
	sameColor,
	surface,
	tokenRows,
} from "@chopin/color";
import { CurveIcon } from "@chopin/icons";
import { currentViewport, listenToViewportChanges } from "@chopin/viewport";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { ColorPopover } from "./color-popover";
import { placePopover } from "./geometry";
import { PaletteGrid } from "./palette-grid";
import { RampCurveEditor } from "./ramp-curve-editor";
import { ThemeToggle } from "./theme-toggle";
import { TokenList } from "./token-list";

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
	let pointerDismissal = useRef<{ target: HTMLElement | null } | null>(null);
	let shortRowReason = useId();
	let [purpose, setPurpose] = useState<Purpose>("graphic");
	let [against, setAgainst] = useState("surface");
	let [curveOpen, setCurveOpen] = useState(false);
	let [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	let selected = state.selected;
	let pending = changes(state).length;
	let rows = gridRows(state);

	useLayoutEffect(() => {
		if (!selected) return;
		function trackPointerDown(event: PointerEvent) {
			if (event.target instanceof Element && !popover.current?.contains(event.target)) {
				let target = event.target.closest(
					'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
				);
				pointerDismissal.current = { target: target instanceof HTMLElement ? target : null };
			}
		}
		function place() {
			let element = popover.current;
			let trigger = anchor.current;
			if (!element || !trigger) return;
			let size = { width: element.offsetWidth, height: element.offsetHeight };
			setPosition(placePopover(trigger.getBoundingClientRect(), size, currentViewport()));
		}
		place();
		// The pane and its discard note can change size after opening or editing.
		let resizeObserver = new ResizeObserver(place);
		resizeObserver.observe(popover.current!);
		let stopListening = listenToViewportChanges(place, { observeDocumentScroll: true });
		document.addEventListener("pointerdown", trackPointerDown, true);
		return () => {
			resizeObserver.disconnect();
			stopListening();
			document.removeEventListener("pointerdown", trackPointerDown, true);
		};
	}, [selected, curveOpen]);

	function open(ref: SwatchRef, element: HTMLElement) {
		anchor.current = element;
		pointerDismissal.current = null;
		setCurveOpen(false);
		flushSync(() => dispatch({ type: "select", ref }));
		if (!popover.current?.matches(":popover-open")) popover.current?.showPopover();
		popover.current?.querySelector<HTMLElement>(
			'button:not(:disabled), [tabindex="0"], select, input',
		)?.focus({ preventScroll: true });
	}

	function changeTheme(theme: PaletteState["theme"]) {
		if (theme === state.theme) return;
		popover.current?.hidePopover();
		anchor.current = null;
		pointerDismissal.current = null;
		setCurveOpen(false);
		setAgainst("surface");
		dispatch({ type: "theme", theme });
	}

	let value = selected && currentValue(state, selected);
	let previous = selected && baseValue(state, selected);
	let row = selected && rowValues(state, selected.hue);
	let curve = selected && curveFor(state, selected.hue);
	let canCurve = !!row && row.steps.length >= 2;
	let colorPopover = selected && value && previous && (
		<ColorPopover
			actions={
				<>
					<button
						aria-describedby={canCurve ? undefined : shortRowReason}
						aria-expanded={curveOpen && canCurve}
						aria-label={`Edit ${selected.hue} ramp curve`}
						className="cv-curve-toggle"
						disabled={!canCurve}
						onClick={() => setCurveOpen(open => !open)}
						type="button"
					>
						<CurveIcon size={16} />
					</button>
					{!canCurve && (
						<span className="cv-visually-hidden" id={shortRowReason}>
							Needs at least two colors
						</span>
					)}
				</>
			}
			contrast={{
				against,
				onAgainstChange: setAgainst,
				onPurposeChange: setPurpose,
				options: contrastOptions(state),
				purpose,
			}}
			fieldKey={JSON.stringify([state.theme, selected.hue, selected.step])}
			onChange={next => dispatch({ type: "edit", ref: selected, value: next })}
			previous={previous}
			title={title(selected)}
			value={value}
		/>
	);
	return (
		<div className="cv-palette-editor">
			{!!state.palette.themes.dark?.length && (
				<div className="cv-palette-toolbar">
					<ThemeToggle onChange={changeTheme} value={state.theme} />
				</div>
			)}
			<PaletteGrid onActivate={open} rows={rows} />
			{!!state.palette.tokens?.length && (
				<section className="cv-palette-tokens">
					<h2>Tokens</h2>
					<TokenList
						onOpen={open}
						onRetarget={(token, ref) => dispatch({ type: "retarget", token, ref })}
						rows={tokenRows(state)}
						swatches={rows.flatMap(row => row.cells.map(cell => cell.ref))}
					/>
				</section>
			)}
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
				data-curve-open={curveOpen && canCurve}
				onToggle={event => {
					if (event.newState !== "closed" || popover.current?.matches(":popover-open")) return;
					dispatch({ type: "select", ref: null });
					setCurveOpen(false);
					if (pointerDismissal.current) {
						pointerDismissal.current.target?.focus({ preventScroll: true });
					} else anchor.current?.focus({ preventScroll: true });
					pointerDismissal.current = null;
				}}
				popover="auto"
				ref={popover}
				style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}
			>
				<div className="cv-palette-popover-body">
					{colorPopover}
					{curveOpen && row && curve && canCurve && (
						<RampCurveEditor
							current={row.current}
							curve={curve}
							edited={row.current.some((entry, index) => !sameColor(entry, row.base[index]))}
							onCurveChange={next => dispatch({ type: "curve", hue: selected!.hue, curve: next })}
							onDiscard={() => dispatch({ type: "resetRow", hue: selected!.hue })}
							steps={row.steps}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
