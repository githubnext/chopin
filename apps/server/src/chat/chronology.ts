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

function lastSeqOf(transcript: Transcript): number {
	return Math.max(transcript.lastSeq ?? 0, transcript.entries.at(-1)?.seq ?? 0);
}

/**
 * Give entries their time and sequence for the end of a transcript, without adding them. An entry
 * never goes before the second of the one ahead of it: a clock that stepped back, or an entry made
 * a moment before it was added, is given the time of the one ahead. Its sequence is the server's
 * clock in milliseconds, or one more than the last given out where that is later, so it is past
 * every entry and snapshot of the transcript, and of the transcript it is copied into. An entry that
 * already has a later time and sequence keeps them. Says whether it moved one that had them.
 */
export function stampEntries(transcript: Transcript, ...added: Wire.Entry[]): boolean {
	let lastTs = transcript.entries.at(-1)?.ts;
	let lastSeq = lastSeqOf(transcript);
	let moved = false;
	for (let entry of added) {
		let shared = transcript.sharedWith?.(entry);
		let sharedTs = shared?.entries.at(-1)?.ts;
		let ts = Math.max(entry.ts, lastTs ?? entry.ts, sharedTs ?? entry.ts);
		let seq = Math.max(
			entry.seq ?? Date.now(),
			Math.max(lastSeq, shared ? lastSeqOf(shared) : 0) + 1,
		);
		if (entry.seq !== undefined && (seq !== entry.seq || ts !== entry.ts)) moved = true;
		entry.ts = ts;
		entry.seq = seq;
		lastTs = ts;
		lastSeq = seq;
	}
	return moved;
}

/**
 * Add entries to the end of a transcript, which is kept in the order things happened. Says whether
 * it moved an entry stamped before (`stampEntries`), which must then be saved again.
 */
export function appendEntries(transcript: Transcript, ...added: Wire.Entry[]): boolean {
	let moved = stampEntries(transcript, ...added);
	transcript.entries.push(...added);
	let last = added.at(-1)?.seq;
	if (last !== undefined) transcript.lastSeq = last;
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
