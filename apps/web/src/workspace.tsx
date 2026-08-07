/** Three panes on one ground, with the document as the only raised surface. */

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

/** Accessible resize handle; pointer capture keeps drags active off the boundary. */
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
			// Lost capture covers ordinary release and every form of pointer cancellation.
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
	let [chatWidth, resizeChat] = usePaneWidth("chopin:pane:chat", 340);
	let [decisionsWidth, resizeDecisions] = usePaneWidth("chopin:pane:decisions", 320);

	return (
		<div className="flex h-full flex-col overflow-hidden bg-ground">
			{header}

			<div className="flex min-h-0 flex-1 pt-4">
				{chat && (
					<aside className="min-w-0 shrink-0 overflow-hidden" style={{ width: chatWidth }}>
						{chat}
					</aside>
				)}

				<main className="relative min-w-0 flex-1 px-1">
					{/* Decoration extends below the viewport without moving the editor contents. */}
					<div
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-1 top-0 -bottom-3 rounded-t-xl bg-page shadow-raised ring-hairline"
					/>

					{/* Lexical consumes Tab, so both handles must precede the editor. */}
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

					<div className="relative h-full overflow-hidden rounded-t-xl">{plan}</div>
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
