/**
 * The three panes.
 *
 * Chat on the left, the plan in the middle, decisions on the right. All three
 * are visible at once by design: the thing worth watching is the agent editing
 * prose while you are reading it, and a tab would hide exactly that.
 *
 * A pane that has nothing to show is not rendered, so the grid collapses to
 * whatever exists rather than reserving space for a placeholder.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ReactNode } from "react";

const MIN = 240;
const MAX = 520;

type Side = "left" | "right";

function clamp(value: number): number {
	return Math.min(MAX, Math.max(MIN, value));
}

/**
 * A draggable edge.
 *
 * Pointer capture rather than window listeners: the pointer leaves the handle
 * immediately on any real drag, and capture is what keeps the events coming
 * without a document-level subscription to tear down.
 */
function Handle({ onResize, side }: { onResize: (delta: number) => void; side: Side }) {
	let origin = useRef<number>(0);

	return (
		<div
			aria-hidden="true"
			className="relative z-10 w-[var(--edge-width)] shrink-0 cursor-col-resize bg-edge transition before:absolute before:inset-y-0 before:-inset-x-1 before:content-[''] hover:bg-brand"
			onPointerDown={event => {
				origin.current = event.clientX;
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={event => {
				if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
				let delta = event.clientX - origin.current;
				origin.current = event.clientX;
				onResize(side === "left" ? delta : -delta);
			}}
			onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
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
		<div className="flex h-full flex-col">
			{header}
			<div className="flex min-h-0 flex-1">
				{chat && (
					<>
						<aside
							className="min-w-0 shrink-0 overflow-hidden bg-ground"
							style={{ width: chatWidth }}
						>
							{chat}
						</aside>
						<Handle onResize={resizeChat} side="left" />
					</>
				)}

				<main className="min-w-0 flex-1">{plan}</main>

				{decisions && (
					<>
						<Handle onResize={resizeDecisions} side="right" />
						<aside
							className="min-w-0 shrink-0 overflow-hidden bg-ground"
							style={{ width: decisionsWidth }}
						>
							{decisions}
						</aside>
					</>
				)}
			</div>
		</div>
	);
}
