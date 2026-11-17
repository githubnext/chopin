/**
 * The order a transcript is read in: by when each thing happened, in seconds.
 *
 * The server keeps a transcript's entries in the order it appended them, and never appends one
 * earlier than the last (`appendEntries` on the server). Entries at the same second keep that
 * order. What only this browser has (a message still sending, chopin's note to this person alone,
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

/** Where an entry of time `ts` goes: after every entry of its second or before. */
export function placeOf(entries: readonly { ts: number }[], ts: number): number {
	let at = entries.length;
	while (at > 0 && entries[at - 1]!.ts > ts) at--;
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
