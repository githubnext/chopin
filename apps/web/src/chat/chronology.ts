/**
 * The order a transcript is read in: by when each thing happened, in seconds, then by the
 * server's sequence (`Entry.seq`).
 *
 * The server keeps a transcript's entries in the order it appended them, and never appends one
 * earlier than the last (`appendEntries` on the server), so this is the order it stores them in.
 * An entry saved before the sequence existed keeps its place in that list among those of its
 * second. What only this browser has (a message still sending, chopin's note to this person alone,
 * a local notice under a send) takes its place among them by its own time, after the entries of
 * the same second, or right under the message it is about.
 */

import type { Chat } from "@chopin/protocol";

/** What only this browser shows in a transcript. */
export type Local =
	/** A message still sending, or a notice; with `after`, it goes right under that message. */
	| { kind: "entry"; entry: Chat.Entry; after?: string }
	/** chopin's note to this person alone, drawn by the transcript where it falls. */
	| { kind: "note"; id: string; ts: number };

export type NoteRow = Extract<Local, { kind: "note" }>;

export type Placed<T> = T | NoteRow;

export function isNote(row: object): row is NoteRow {
	return (row as { kind?: unknown }).kind === "note";
}

type Timed = { ts: number; seq?: number };

/** Whether `entry` is read after `other`, as far as their time and sequence say. */
export function readsAfter(entry: Timed, other: Timed): boolean {
	if (entry.ts !== other.ts) return entry.ts > other.ts;
	return entry.seq !== undefined && other.seq !== undefined && entry.seq > other.seq;
}

/**
 * Where an entry goes: after every entry read before it, and after one of its second whose
 * sequence, or its own, is unknown.
 */
export function placeOf(entries: readonly Timed[], entry: Timed): number {
	let at = entries.length;
	while (at > 0 && readsAfter(entries[at - 1]!, entry)) at--;
	return at;
}

/**
 * `entries` with `local` among them. A local entry the transcript already holds is left out, so a
 * message that arrived while its echo was still kept is shown once. One placed after a message the
 * transcript does not show is left out too.
 */
export function interleave<T extends { id: string; ts: number }>(
	entries: readonly T[],
	local: readonly Local[],
	toRow: (entry: Chat.Entry) => T,
): Placed<T>[] {
	if (local.length === 0) return [...entries];
	let shown = new Set(entries.map(entry => entry.id));
	let under = new Map<string, Chat.Entry[]>();
	let timed: { row: Placed<T>; ts: number; order: number }[] = [];
	for (let [order, item] of local.entries()) {
		if (item.kind === "note") {
			timed.push({ row: item, ts: item.ts, order });
			continue;
		}
		if (shown.has(item.entry.id)) continue;
		shown.add(item.entry.id);
		if (item.after === undefined) {
			timed.push({ row: toRow(item.entry), ts: item.entry.ts, order });
		} else under.set(item.after, [...under.get(item.after) ?? [], item.entry]);
	}
	timed.sort((a, b) => a.ts - b.ts || a.order - b.order);
	let rows: Placed<T>[] = [];
	let next = 0;
	let place = (row: Placed<T>) => {
		rows.push(row);
		if (isNote(row)) return;
		for (let notice of under.get(row.id) ?? []) rows.push(toRow(notice));
	};
	for (let entry of entries) {
		while (next < timed.length && timed[next]!.ts < entry.ts) place(timed[next++]!.row);
		place(entry);
	}
	while (next < timed.length) place(timed[next++]!.row);
	return rows;
}

/** Messages still sending, and each local notice under the message it answers. */
export function localRows(
	sending: readonly Chat.Entry[],
	notices: Readonly<Record<string, Chat.Entry>>,
): Local[] {
	return [
		...sending.map(entry => ({ kind: "entry" as const, entry })),
		...Object.entries(notices).map(([after, entry]) => ({ kind: "entry" as const, entry, after })),
	];
}
