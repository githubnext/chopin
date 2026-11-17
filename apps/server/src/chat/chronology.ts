import type { Chat as Wire } from "@chopin/protocol";

/**
 * A transcript the server appends to: Chat, or one thread. `lastSeq` is the last sequence it gave
 * out, which taking entries out moves past, and which is saved with the transcript so that a
 * restart, even one whose clock is behind, gives out none it gave before. `sharedWith` names the
 * other transcript an entry appended here is copied into, so the entry is given a time and
 * sequence that are right in both.
 */
export type Transcript = {
	entries: Wire.Entry[];
	lastSeq?: number;
	sharedWith?: (entry: Wire.Entry) => Transcript | undefined;
};

let placed = new WeakSet<Wire.Entry>();
let lastTs = new WeakMap<Transcript, number>();

function lastTsOf(transcript: Transcript): number | undefined {
	let entryTs = transcript.entries.at(-1)?.ts;
	let tracked = lastTs.get(transcript);
	if (entryTs === undefined) return tracked;
	return tracked === undefined ? entryTs : Math.max(entryTs, tracked);
}

function lastSeqOf(transcript: Transcript): number {
	let last = transcript.lastSeq ?? 0;
	for (let entry of transcript.entries) {
		if (entry.seq !== undefined && entry.seq > last) last = entry.seq;
	}
	return last;
}

function readsAfter(entry: Wire.Entry, other: Wire.Entry): boolean {
	if (entry.ts !== other.ts) return entry.ts > other.ts;
	return entry.seq !== undefined && other.seq !== undefined && entry.seq > other.seq;
}

function placeIn(entries: Wire.Entry[], entry: Wire.Entry): void {
	let at = entries.length;
	while (at > 0 && readsAfter(entries[at - 1]!, entry)) at--;
	entries.splice(at, 0, entry);
}

/**
 * Give entries their time and sequence for the end of a transcript, without adding them. An entry
 * never goes before the second of the one ahead of it: a clock that stepped back, or an entry made
 * a moment before it was added, is given the time of the one ahead. Its sequence is the server's
 * clock in milliseconds, or one more than the last given out where that is later, so it is past
 * every entry and snapshot of the transcript, and of the transcript it is copied into. An entry
 * already placed in a thread keeps its time and sequence when copied into Chat. Says whether it
 * moved an entry stamped before adding (`stampEntries`).
 */
export function stampEntries(transcript: Transcript, ...added: Wire.Entry[]): boolean {
	let currentTs = lastTsOf(transcript);
	let currentSeq = lastSeqOf(transcript);
	let moved = false;
	for (let entry of added) {
		if (placed.has(entry) || (entry.fromThread !== undefined && entry.seq !== undefined)) {
			currentTs = currentTs === undefined ? entry.ts : Math.max(currentTs, entry.ts);
			if (entry.seq !== undefined) currentSeq = Math.max(currentSeq, entry.seq);
			continue;
		}
		let shared = transcript.sharedWith?.(entry);
		let sharedTs = shared ? lastTsOf(shared) : undefined;
		let ts = Math.max(entry.ts, currentTs ?? entry.ts, sharedTs ?? entry.ts);
		let seq = Math.max(
			entry.seq ?? Date.now(),
			Math.max(currentSeq, shared ? lastSeqOf(shared) : 0) + 1,
		);
		if (entry.seq !== undefined && (seq !== entry.seq || ts !== entry.ts)) moved = true;
		entry.ts = ts;
		entry.seq = seq;
		currentTs = ts;
		currentSeq = seq;
		if (shared) {
			lastTs.set(shared, Math.max(sharedTs ?? ts, ts));
			shared.lastSeq = Math.max(lastSeqOf(shared), seq);
		}
	}
	if (currentTs !== undefined) lastTs.set(transcript, currentTs);
	return moved;
}

/**
 * Add entries to a transcript in the order things happened. A copy from a thread keeps the time
 * and sequence the thread gave it and takes its place by them. Says whether it moved an entry
 * stamped before (`stampEntries`), which must then be saved again.
 */
export function appendEntries(transcript: Transcript, ...added: Wire.Entry[]): boolean {
	let moved = stampEntries(transcript, ...added);
	let maxSeq = lastSeqOf(transcript);
	for (let entry of added) {
		placed.add(entry);
		placeIn(transcript.entries, entry);
		if (entry.seq !== undefined && entry.seq > maxSeq) maxSeq = entry.seq;
	}
	if (maxSeq > 0) transcript.lastSeq = maxSeq;
	return moved;
}

/**
 * Take entries out of a transcript for good, as a Retry does, and move its sequence past them, so
 * a copy of the transcript taken after it says it is newer than one that still had them. Save the
 * transcript before anyone is told.
 */
export function takeOut(transcript: Transcript, ids: Iterable<string>): void {
	let gone = new Set(ids);
	if (!transcript.entries.some(entry => gone.has(entry.id))) return;
	transcript.lastSeq = lastSeqOf(transcript) + 1;
	transcript.entries = transcript.entries.filter(entry => !gone.has(entry.id));
}

/**
 * The sequence a copy of the whole transcript is sent with: every entry it holds has one at most
 * as large, and every entry appended after it a larger one, so a reader can tell an entry newer
 * than the copy from one taken out before it. It gives out no new sequence, so it is never more
 * than what was saved.
 */
export function snapshotSeq(transcript: Transcript): number {
	return lastSeqOf(transcript);
}
