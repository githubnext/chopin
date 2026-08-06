/**
 * The shell, as two layers.
 *
 * One ground carries the nav and both rails; the document page is the only
 * surface standing on it. The rails are not panels — no fill, no border, no
 * shadow — so the ground runs unbroken behind the nav, behind both of them and
 * through the gutters either side of the page. That is what makes the page the
 * subject: it is the only thing lifted off anything.
 *
 * It also makes a collapsed rail a width, rather than a surface appearing and
 * disappearing. Neither rail collapses yet; the ground is already behind them
 * for when one does.
 *
 * A pane that has nothing to show is not rendered, so the row collapses to
 * whatever exists rather than reserving space for a placeholder.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ReactNode } from "react";

const MIN = 240;
const MAX = 520;

/** How far one arrow key moves an edge, and how far one with Shift held moves it. */
const STEP = 16;
const LEAP = 64;

type Side = "left" | "right";

function clamp(value: number): number {
	return Math.min(MAX, Math.max(MIN, value));
}

/**
 * A draggable edge, drawn only when it is being aimed at.
 *
 * There is no seam between a rail and the page for a pointer to find, so the
 * affordance has to arrive with the pointer: nothing at rest, a bar under the
 * hand. It is laid over the four pixels of ground beside the page rather than
 * taking a column in the row, because those four pixels are measured and a
 * handle in the row would be a fifth. Four pixels is a small thing to aim at,
 * so `::before` spreads the hit area either side of them.
 *
 * Reachable without a pointer, too, which is the other half of drawing nothing:
 * a splitter that only exists on hover is a splitter a keyboard cannot find
 * unless it is in the tab order and says what it is worth. Focus keeps the
 * outline the theme gives everything else, so it does not read as a hover.
 *
 * Pointer capture rather than window listeners: the pointer leaves the handle
 * immediately on any real drag, and capture is what keeps the events coming
 * without a document-level subscription to tear down. Capture does not reliably
 * keep `:hover`, so the bar is held by a state of its own for the length of a
 * drag rather than blinking out from under the hand moving it.
 */
function Handle(
	{ label, onResize, side, width }: {
		label: string;
		onResize: (delta: number) => void;
		side: Side;
		width: number;
	},
) {
	let origin = useRef<number>(0);
	let [dragging, setDragging] = useState(false);

	return (
		<div
			aria-label={label}
			aria-orientation="vertical"
			aria-valuemax={MAX}
			aria-valuemin={MIN}
			aria-valuenow={width}
			className={`absolute inset-y-0 z-10 w-1 cursor-col-resize
				before:absolute before:inset-y-0 before:-inset-x-1 before:content-['']
				after:absolute after:inset-x-px after:inset-y-0 after:rounded-full after:bg-brand
				after:opacity-0 after:transition-opacity hover:after:opacity-100
				data-dragging:after:opacity-100 ${side === "left" ? "left-0" : "right-0"}`}
			data-dragging={dragging || undefined}
			onKeyDown={event => {
				let step = event.shiftKey ? LEAP : STEP;
				// A rail on the right grows leftward, so the key names a direction
				// on the screen rather than a direction in the layout.
				let toward = side === "left" ? 1 : -1;

				if (event.key === "ArrowRight") onResize(step * toward);
				else if (event.key === "ArrowLeft") onResize(-step * toward);
				else if (event.key === "Home") onResize(MIN - width);
				else if (event.key === "End") onResize(MAX - width);
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
				onResize(side === "left" ? delta : -delta);
			}}
			// The one place a drag ends. `pointerup` is not: Escape, a pen leaving
			// the tablet, a touch the browser takes back all end a drag through
			// `pointercancel` instead, and capture is released implicitly by every
			// one of them — including by an ordinary release. Clearing the state
			// anywhere else leaves the bar painted with no pointer near it.
			onLostPointerCapture={() => setDragging(false)}
			role="separator"
			tabIndex={0}
		/>
	);
}

function usePaneWidth(key: string, initial: number) {
	let [width, setWidth] = useState(() => {
		let stored = Number(localStorage.getItem(key));
		return Number.isFinite(stored) && stored > 0 ? clamp(stored) : initial;
	});

	useEffect(() => {
		localStorage.setItem(key, String(width));
	}, [key, width]);

	let resize = useCallback((delta: number) => setWidth(current => clamp(current + delta)), []);
	return [width, resize] as const;
}

export type WorkspaceProps = {
	header: ReactNode;
	chat?: ReactNode;
	plan: ReactNode;
	decisions?: ReactNode;
};

export function Workspace({ chat, decisions, header, plan }: WorkspaceProps) {
	let [chatWidth, resizeChat] = usePaneWidth("chopin:pane:chat", 320);
	let [decisionsWidth, resizeDecisions] = usePaneWidth("chopin:pane:decisions", 280);

	return (
		// Clipped, because the page is deliberately taller than the room it is in.
		<div className="flex h-full flex-col overflow-hidden bg-ground">
			{header}

			{/* The 16px the page needs below the nav; the rails begin level with it. */}
			<div className="flex min-h-0 flex-1 pt-4">
				{chat && (
					<aside className="min-w-0 shrink-0 overflow-hidden" style={{ width: chatWidth }}>
						{chat}
					</aside>
				)}

				{/* Both gutters belong to the page, so both handles live in it. */}
				<main className="relative min-w-0 flex-1 px-1">
					{
						/*
						 * The page itself, behind its contents rather than around them.
						 *
						 * It runs past the bottom of the window, so the ring, the shadow and
						 * the two square corners that would say where it ends are all below
						 * the fold — the page reads as continuing rather than as stopping
						 * short. Its contents cannot go with it or the last line of the plan
						 * would be off screen, which is why this is a sibling and not a
						 * wrapper. The inset either side is the same four pixels `main` pads
						 * by, measured from the padding box the two of them share.
						 */
					}
					<div
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-1 top-0 -bottom-3 rounded-t-xl bg-page shadow-raised ring-hairline"
					/>
					<div className="relative h-full overflow-hidden rounded-t-xl">{plan}</div>

					{chat && (
						<Handle
							label="Resize the conversation"
							onResize={resizeChat}
							side="left"
							width={chatWidth}
						/>
					)}
					{decisions && (
						<Handle
							label="Resize the decisions"
							onResize={resizeDecisions}
							side="right"
							width={decisionsWidth}
						/>
					)}
				</main>

				{decisions && (
					<aside className="min-w-0 shrink-0 overflow-hidden" style={{ width: decisionsWidth }}>
						{decisions}
					</aside>
				)}
			</div>
		</div>
	);
}
