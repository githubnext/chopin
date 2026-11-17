import type { Chat as Wire } from "@chopin/protocol";

/**
 * Add entries to the end of a transcript, which is kept in the order things happened: an entry
 * never goes before the second of the one ahead of it. A clock that stepped back, or an entry made
 * a moment before it was added, is given the time of the one ahead, so every reader that places
 * entries by time puts each where the server has it. Entries of the same second keep the order
 * they were added in.
 */
export function appendEntries(entries: Wire.Entry[], ...added: Wire.Entry[]): void {
	for (let entry of added) {
		let last = entries.at(-1);
		if (last && entry.ts < last.ts) entry.ts = last.ts;
		entries.push(entry);
	}
}
