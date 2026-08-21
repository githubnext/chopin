import { useCallback, useEffect, useRef, useState } from "react";

export type PaneSide = "left" | "right";

const STEP = 16;
const LEAP = 64;

export function clampPane(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Translates an on-screen drag into the width change for the pane's edge. */
export function resizeDelta(side: PaneSide, delta: number): number {
	return side === "left" ? delta : -delta;
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
				let step = event.shiftKey ? LEAP : STEP;
				let toward = side === "left" ? 1 : -1;

				if (event.key === "ArrowRight") onResize(step * toward);
				else if (event.key === "ArrowLeft") onResize(-step * toward);
				else if (event.key === "Home") onResize(min - width);
				else if (event.key === "End") onResize(max - width);
				else return;

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
	{ active, initial, max, min, storageKey }: {
		active: boolean;
		initial: number;
		max: number;
		min: number;
		storageKey: string;
	},
): readonly [number, (delta: number) => void] {
	let [width, setWidth] = useState(initial);
	let loaded = useRef(false);

	useEffect(() => {
		if (!active) return;
		if (!loaded.current) {
			loaded.current = true;
			let stored = Number(localStorage.getItem(storageKey));
			let restored = Number.isFinite(stored) && stored > 0
				? clampPane(stored, min, max)
				: initial;
			if (restored !== width) {
				setWidth(restored);
				return;
			}
		}
		localStorage.setItem(storageKey, String(width));
	}, [active, initial, max, min, storageKey, width]);

	let resize = useCallback(
		(delta: number) => setWidth(current => clampPane(current + delta, min, max)),
		[max, min],
	);
	return [width, resize];
}
