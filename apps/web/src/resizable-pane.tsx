import { useCallback, useEffect, useRef, useState } from "react";

export type PaneSide = "left" | "right";

export type PaneBounds = {
	initial: number;
	min: number;
	max: number;
};

const STEP = 16;
const LEAP = 64;

export function clampPane(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Translates an on-screen drag into the width change for the pane's edge. */
export function resizeDelta(side: PaneSide, delta: number): number {
	return side === "left" ? delta : -delta;
}

export function restorePaneWidth(stored: string | null, { initial, min, max }: PaneBounds): number {
	let value = Number(stored);
	return Number.isFinite(value) && value > 0 ? clampPane(value, min, max) : initial;
}

type PaneStorage = Pick<Storage, "getItem" | "setItem">;

export function readPaneWidth(
	storage: PaneStorage,
	storageKey: string | undefined,
	bounds: PaneBounds,
): number {
	return storageKey ? restorePaneWidth(storage.getItem(storageKey), bounds) : bounds.initial;
}

export function writePaneWidth(
	storage: PaneStorage,
	storageKey: string | undefined,
	width: number,
): void {
	if (storageKey) storage.setItem(storageKey, String(width));
}

export function keyboardPaneDelta(
	side: PaneSide,
	key: string,
	shiftKey: boolean,
	width: number,
	{ min, max }: Pick<PaneBounds, "min" | "max">,
): number | undefined {
	let step = shiftKey ? LEAP : STEP;
	if (key === "ArrowRight") return resizeDelta(side, step);
	if (key === "ArrowLeft") return resizeDelta(side, -step);
	if (key === "Home") return min - width;
	if (key === "End") return max - width;
}

export function ResizeHandle(
	{ label, max, min, onResize, side, width }: {
		label: string;
		max: number;
		min: number;
		onResize: (delta: number) => void;
		side: PaneSide;
		width: number;
	},
) {
	let origin = useRef<number>(0);
	let [dragging, setDragging] = useState(false);

	return (
		<div
			aria-label={label}
			aria-orientation="vertical"
			aria-valuemax={max}
			aria-valuemin={min}
			aria-valuenow={width}
			className={`absolute inset-y-0 z-10 w-1 cursor-col-resize
				before:absolute before:inset-y-0 before:-inset-x-1 before:content-['']
				after:absolute after:inset-x-px after:inset-y-0 after:rounded-full after:bg-brand
				after:opacity-0 after:transition-opacity hover:after:opacity-100
				data-dragging:after:opacity-100 ${side === "left" ? "left-0" : "right-0"}`}
			data-dragging={dragging || undefined}
			onKeyDown={event => {
				let delta = keyboardPaneDelta(side, event.key, event.shiftKey, width, { min, max });
				if (delta === undefined) return;

				onResize(delta);
				event.preventDefault();
			}}
			onPointerDown={event => {
				origin.current = event.clientX;
				setDragging(true);
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={event => {
				if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
				let delta = event.clientX - origin.current;
				origin.current = event.clientX;
				onResize(resizeDelta(side, delta));
			}}
			// Lost capture covers ordinary release and every form of pointer cancellation.
			onLostPointerCapture={() => setDragging(false)}
			role="separator"
			tabIndex={0}
		/>
	);
}

export function usePaneWidth(
	{ active, initial, max, min, storageKey }: PaneBounds & {
		active: boolean;
		storageKey?: string;
	},
): readonly [number, (delta: number) => void] {
	let [width, setWidth] = useState(initial);
	let loaded = useRef(false);

	useEffect(() => {
		if (!active) return;
		if (!loaded.current) {
			loaded.current = true;
			let restored = readPaneWidth(localStorage, storageKey, { initial, min, max });
			if (restored !== width) {
				setWidth(restored);
				return;
			}
		}
		writePaneWidth(localStorage, storageKey, width);
	}, [active, initial, max, min, storageKey, width]);

	let resize = useCallback(
		(delta: number) => setWidth(current => clampPane(current + delta, min, max)),
		[max, min],
	);
	return [width, resize];
}
