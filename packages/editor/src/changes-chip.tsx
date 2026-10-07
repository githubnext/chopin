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

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUpIcon, ChevronIcon } from "@chopin/icons";

import { MotionDisclosureIcon } from "./disclosure-motion";
import { usePopoverDismissal } from "./popover-dismissal";

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

/**
 * Who wrote it. A client that never introduced itself is reported by the
 * server as `unknown`, which names nothing a reader could act on; the person
 * whose credential made the call is always known.
 */
export function author(entry: Entry): string | undefined {
	let attribution = entry.attribution;
	if (!attribution) return undefined;
	if (attribution.client.name !== "unknown") return attribution.client.name;
	return `@${attribution.user}`;
}

function provenance(entry: Entry): string | undefined {
	let attribution = entry.attribution;
	if (!attribution) return undefined;
	let client = attribution.client.name === "unknown"
		? "MCP"
		: `${attribution.client.name} ${attribution.client.version}`;
	return `${client} for @${attribution.user}, revisions ${attribution.fromRevision} to ${attribution.revision}`;
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
					<span className="plan-changes-kind" title={provenance(entry)}>
						{label(entry)}
						{author(entry) ? ` by ${author(entry)}` : ""}
					</span>
					<span className="plan-changes-text">{describe(entry)}</span>
				</li>
			))}
		</ul>
	);
}

function Chip(
	{ entries, motionImmediately, onGo, side, waiting }: {
		entries: Entry[];
		motionImmediately?: () => boolean;
		onGo: () => void;
		side: "above" | "below";
		waiting: number;
	},
) {
	let [open, setOpen] = useState(false);
	let [iconMotionOwner, setIconMotionOwner] = useState<"immediate" | "pointer">();
	let box = useRef<HTMLDivElement>(null);
	let more = useRef<HTMLButtonElement>(null);

	// Once every change in this direction is read, the list has nothing left
	// to show. Adjusting state during render (rather than in an Effect that
	// fires after the fact) closes it in the same commit, with no extra pass
	// where a stale, now-empty list is still open.
	let [openedForWaiting, setOpenedForWaiting] = useState(waiting);
	if (waiting !== openedForWaiting) {
		setOpenedForWaiting(waiting);
		if (waiting === 0) {
			setIconMotionOwner(undefined);
			setOpen(false);
		}
	}

	// Outside the whole box rather than blur: the list is inside the same box
	// as the button, so blur fires on the way to clicking it.
	usePopoverDismissal(open, target => box.current?.contains(target), restoreFocus => {
		setIconMotionOwner(restoreFocus ? "immediate" : "pointer");
		setOpen(false);
		if (restoreFocus) more.current?.focus();
	});

	if (waiting === 0) return null;

	let summary = `${count(waiting)} ${waiting === 1 ? "change" : "changes"} ${side}`;

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
					aria-label={summary}
					data-tooltip={summary}
				>
					<ArrowUpIcon
						className={side === "below" ? "rotate-180" : undefined}
						size={14}
					/>
					<span className="tabular-nums" aria-hidden="true">{count(waiting)}</span>
				</button>
				<button
					type="button"
					className="plan-changes-more"
					ref={more}
					data-tooltip="View changes"
					aria-expanded={open}
					onClick={() => {
						setIconMotionOwner(
							motionImmediately?.() ? "immediate" : "pointer",
						);
						setOpen(value => !value);
					}}
				>
					<MotionDisclosureIcon
						className="editor-motion-feedback"
						closed={<ChevronIcon size={14} />}
						motionOwner={iconMotionOwner}
						open={open}
						opened={
							<ChevronIcon className={side === "below" ? "-rotate-90" : "rotate-90"} size={14} />
						}
					/>
					<span className="sr-only">What the agent changed</span>
				</button>
			</div>
		</div>
	);
}

export function PlanChanges(
	{ motionImmediately, store }: { motionImmediately?: () => boolean; store: ChangeStore },
) {
	let { above, below, entries } = useChanges(store);

	let goUp = useCallback(() => store.reveal("above"), [store]);
	let goDown = useCallback(() => store.reveal("below"), [store]);

	return (
		<>
			<Chip
				entries={entries}
				motionImmediately={motionImmediately}
				onGo={goUp}
				side="above"
				waiting={above}
			/>
			<Chip
				entries={entries}
				motionImmediately={motionImmediately}
				onGo={goDown}
				side="below"
				waiting={below}
			/>
		</>
	);
}
