/**
 * How to reach what the agent changed while you were reading somewhere else.
 *
 * A mark is held back until it is on screen, which answers the question of
 * whether it was worth showing but not the question of how to find it. These
 * are the other half: one chip per edge, counting only what is still unread in
 * that direction, and going to the nearest one when clicked — which reveals it
 * the ordinary way, by putting it in front of the reader.
 *
 * The list behind them shows every live change, seen or not. That is the only
 * place a removal can be read: the hole in the prose can say that something
 * was here, but the block itself is gone and cannot be asked what it was.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ChangeStore, Entry, Snapshot } from "./changes";

/** Past this the number stops being informative and starts being noise. */
const MANY = 9;

export function useChanges(store: ChangeStore): Snapshot {
	return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

function count(value: number): string {
	return value > MANY ? `${MANY}+` : String(value);
}

function label(entry: Entry): string {
	switch (entry.kind) {
		case "added":
			return "Written";
		case "moved":
			return "Moved";
		case "removed":
			return entry.blocks.length > 1 ? `Removed ${entry.blocks.length} blocks` : "Removed";
	}
}

function describe(entry: Entry): string {
	let first = entry.blocks[0];
	if (!first) return "";
	let text = first.preview.trim();
	// A block with no words of its own — a divider, an image, a component with
	// nothing written in it — is named by what it is instead.
	return text || first.type;
}

function List({ entries }: { entries: Entry[] }) {
	if (entries.length === 0) {
		return <p className="plan-changes-empty">Nothing recent.</p>;
	}

	return (
		<ul className="plan-changes-list">
			{entries.map(entry => (
				<li
					key={entry.id}
					className="plan-changes-item"
					data-kind={entry.kind}
					// Held back rather than shown yet, which is the difference
					// between this list and a plain history of the turn.
					data-unread={entry.seen ? undefined : ""}
				>
					<span className="plan-changes-kind">{label(entry)}</span>
					<span className="plan-changes-text">{describe(entry)}</span>
				</li>
			))}
		</ul>
	);
}

function Chip(
	{ entries, onGo, side, waiting }: {
		entries: Entry[];
		onGo: () => void;
		side: "above" | "below";
		waiting: number;
	},
) {
	let [open, setOpen] = useState(false);
	let box = useRef<HTMLDivElement>(null);

	// Once every change in this direction is read, the list has nothing left
	// to show. Adjusting state during render (rather than in an Effect that
	// fires after the fact) closes it in the same commit, with no extra pass
	// where a stale, now-empty list is still open.
	let [openedForWaiting, setOpenedForWaiting] = useState(waiting);
	if (waiting !== openedForWaiting) {
		setOpenedForWaiting(waiting);
		if (waiting === 0) setOpen(false);
	}

	// Closing on an outside click rather than on blur: the list is inside the
	// same box as the button, so blur fires on the way to clicking it.
	useEffect(() => {
		if (!open) return;
		let close = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);

	if (waiting === 0) return null;

	return (
		<div ref={box} className="plan-changes" data-side={side}>
			{open && <List entries={entries} />}
			<div
				className="plan-changes-bar editor-motion-feedback"
				data-motion-feedback="count"
			>
				<button
					type="button"
					className="plan-changes-go"
					onClick={onGo}
					title={`Go to the nearest change ${side}`}
				>
					<span aria-hidden="true">{side === "above" ? "↑" : "↓"}</span>
					{`${count(waiting)} ${waiting === 1 ? "change" : "changes"} ${side}`}
				</button>
				<button
					type="button"
					className="plan-changes-more"
					aria-expanded={open}
					onClick={() => setOpen(value => !value)}
					title="What the agent changed"
				>
					<span aria-hidden="true">{open ? "▾" : "▸"}</span>
					<span className="sr-only">What the agent changed</span>
				</button>
			</div>
		</div>
	);
}

export function PlanChanges({ store }: { store: ChangeStore }) {
	let { above, below, entries } = useChanges(store);

	let goUp = useCallback(() => store.reveal("above"), [store]);
	let goDown = useCallback(() => store.reveal("below"), [store]);

	return (
		<>
			<Chip entries={entries} onGo={goUp} side="above" waiting={above} />
			<Chip entries={entries} onGo={goDown} side="below" waiting={below} />
		</>
	);
}
