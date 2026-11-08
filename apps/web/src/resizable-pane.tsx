import { useCallback, useEffect, useRef, useState } from "react";

import { holdPaneDrag } from "./pane-drag-skip";

import type { PointerEvent as ReactPointerEvent } from "react";

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

/**
 * Translates an on-screen drag into a width change for a pane resized from its `side` edge.
 * Moving a left edge rightward narrows the pane; moving a right edge rightward widens it.
 */
export function resizeDelta(side: PaneSide, delta: number): number {
	return side === "left" ? -delta : delta;
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

/** The animation-frame scheduler a drag writes through; the page's own in a browser. */
export type PaneFrames = {
	request: (callback: () => void) => number;
	cancel: (handle: number) => void;
};

export type PaneDrag = {
	/** The pointer moved `delta` pixels along the pane's axis, already signed for its side. */
	move: (delta: number) => void;
	/** The drag is over, however it ended: show what is pending, commit the width, then release. */
	end: () => void;
	/** The handle went away mid-drag: drop a pending frame and release, committing nothing. */
	cancel: () => void;
};

/**
 * One pointer drag of a pane's edge.
 *
 * The width is clamped per move, as the pane's state used to be, so a pointer that overshoots a
 * bound and comes back behaves as it always did. What changes is where the width goes: `show` writes
 * it straight to the page at most once per animation frame, whatever the number of moves in it, and
 * `commit` hands the final width to React state and storage once, when the drag ends. Nothing
 * renders per move. `release` follows, whether or not there was anything to commit, so that what
 * `show` wrote as a stand-in for the width is taken back once the width itself is in place.
 *
 * A press that never moves the edge changes nothing: `begin` runs once, just before the first width
 * is shown, and what it returns runs once, when the drag is over, after `release`.
 */
export function startPaneDrag(
	{ begin, bounds, commit, frames, release, show, width }: {
		/** Runs before the first width is shown; what it returns runs when the drag is over. */
		begin?: () => () => void;
		/** Read on every move, so a window that changes size mid-drag moves the bounds with it. */
		bounds: () => Pick<PaneBounds, "min" | "max">;
		commit: (width: number) => void;
		frames: PaneFrames;
		release?: () => void;
		show: (width: number) => void;
		/** The pane's width when the drag began. */
		width: number;
	},
): PaneDrag {
	let started = width;
	let current = width;
	let shown = width;
	let pending: number | undefined;
	let over = false;
	let begun = false;
	let finish: (() => void) | undefined;

	let flush = () => {
		pending = undefined;
		if (current === shown) return;
		if (!begun) {
			begun = true;
			finish = begin?.();
		}
		shown = current;
		show(shown);
	};

	return {
		move(delta) {
			if (over) return;
			let { min, max } = bounds();
			current = clampPane(current + delta, min, max);
			if (pending === undefined && current !== shown) pending = frames.request(flush);
		},
		end() {
			if (over) return;
			over = true;
			if (pending !== undefined) frames.cancel(pending);
			flush();
			if (current !== started) commit(current);
			release?.();
			finish?.();
		},
		cancel() {
			if (over) return;
			over = true;
			if (pending !== undefined) frames.cancel(pending);
			pending = undefined;
			release?.();
			finish?.();
		},
	};
}

let browserFrames: PaneFrames = {
	request: callback => requestAnimationFrame(() => callback()),
	cancel: handle => cancelAnimationFrame(handle),
};

/**
 * The pointer handlers of a resize handle. A drag writes the width with `show` once per frame and
 * to the handle's own `aria-valuenow`, and `commit`s the final width when the pointer is released,
 * cancelled or its capture lost.
 */
export function usePaneDrag(
	{ commit, max, min, release, show, side, width }: {
		commit: (width: number) => void;
		max: number;
		min: number;
		release?: () => void;
		show: (width: number) => void;
		side: PaneSide;
		width: number;
	},
) {
	let latest = useRef({ commit, max, min, release, show, width });
	latest.current = { commit, max, min, release, show, width };
	let origin = useRef(0);
	let drag = useRef<PaneDrag | undefined>(undefined);
	let [dragging, setDragging] = useState(false);

	useEffect(() => () => drag.current?.cancel(), []);

	return {
		dragging,
		onPointerDown(event: ReactPointerEvent<HTMLElement>) {
			let handle = event.currentTarget;
			origin.current = event.clientX;
			drag.current?.end();
			drag.current = startPaneDrag({
				begin: holdPaneDrag,
				bounds: () => latest.current,
				commit: value => latest.current.commit(value),
				frames: browserFrames,
				release: () => latest.current.release?.(),
				show: value => {
					handle.setAttribute("aria-valuenow", String(value));
					latest.current.show(value);
				},
				width: latest.current.width,
			});
			setDragging(true);
			handle.setPointerCapture(event.pointerId);
		},
		onPointerMove(event: ReactPointerEvent<HTMLElement>) {
			if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
			let delta = event.clientX - origin.current;
			origin.current = event.clientX;
			drag.current?.move(resizeDelta(side, delta));
		},
		// Lost capture covers ordinary release and every form of pointer cancellation.
		onLostPointerCapture() {
			drag.current?.end();
			drag.current = undefined;
			setDragging(false);
		},
	};
}

export function ResizeHandle(
	{ label, max, min, onCommit, onRelease, onResize, onShow, side, width }: {
		label: string;
		max: number;
		min: number;
		/** The width a drag ended on, once, if it ended on a different one. */
		onCommit: (width: number) => void;
		/** After a drag, whatever came of it: what `onShow` wrote gives way to the committed width. */
		onRelease?: () => void;
		/** A keyboard step. */
		onResize: (delta: number) => void;
		/** The width under the pointer, written straight to the page once per frame while dragging. */
		onShow: (width: number) => void;
		side: PaneSide;
		width: number;
	},
) {
	let drag = usePaneDrag({
		commit: onCommit,
		max,
		min,
		release: onRelease,
		show: onShow,
		side,
		width,
	});

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
				after:opacity-0 after:transition-opacity pointer-fine:hover:after:opacity-100
				data-dragging:after:opacity-100 ${side === "left" ? "left-0" : "right-0"}`}
			data-dragging={drag.dragging || undefined}
			onKeyDown={event => {
				let delta = keyboardPaneDelta(side, event.key, event.shiftKey, width, { min, max });
				if (delta === undefined) return;

				onResize(delta);
				event.preventDefault();
			}}
			onLostPointerCapture={drag.onLostPointerCapture}
			onPointerDown={drag.onPointerDown}
			onPointerMove={drag.onPointerMove}
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
): readonly [number, (delta: number) => void, (width: number) => void] {
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
	let set = useCallback((value: number) => setWidth(clampPane(value, min, max)), [max, min]);
	return [width, resize, set];
}
