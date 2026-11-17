import { describe, expect, it } from "bun:test";

import { appendEntries, snapshotSeq, stampEntries } from "./chronology";

import type { Chat as Wire } from "@chopin/protocol";
import type { Transcript } from "./chronology";

function said(id: string, ts: number): Wire.Entry {
	return { id, author: { kind: "system" }, text: id, ts };
}

function order(transcript: Transcript): string[] {
	return [...transcript.entries]
		.sort((a, b) => a.ts - b.ts || a.seq! - b.seq!)
		.map(entry => entry.id);
}

describe("a transcript's entries in time", () => {
	it("adds entries at the end, those of one second in the order they came", () => {
		let transcript: Transcript = { entries: [said("a", 10)] };
		appendEntries(transcript, said("b", 10), said("c", 12));
		expect(transcript.entries.map(entry => [entry.id, entry.ts])).toEqual([
			["a", 10],
			["b", 10],
			["c", 12],
		]);
	});

	it("never puts an entry before the second of the one ahead of it", () => {
		let transcript: Transcript = { entries: [said("a", 20)] };
		let late = said("made-earlier", 18);
		appendEntries(transcript, late);
		expect(late.ts).toBe(20);
		expect(transcript.entries.map(entry => entry.ts)).toEqual([20, 20]);
	});

	it("gives every entry a larger sequence than the one ahead, so time and sequence read in stored order", () => {
		let transcript: Transcript = { entries: [said("legacy", 10)] };
		for (let index = 0; index < 50; index++) appendEntries(transcript, said(`e${index}`, 10));
		let seqs = transcript.entries.slice(1).map(entry => entry.seq!);
		expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!)).toBe(true);
		expect(order({ entries: transcript.entries.slice(1) })).toEqual(
			transcript.entries.slice(1).map(entry => entry.id),
		);
	});

	it("gives an entry appended after a snapshot a larger sequence than the snapshot", () => {
		let transcript: Transcript = { entries: [] };
		appendEntries(transcript, said("a", 10));
		let snapshot = snapshotSeq(transcript);
		expect(snapshot).toBeGreaterThan(transcript.entries[0]!.seq!);
		appendEntries(transcript, said("b", 10));
		expect(transcript.entries[1]!.seq).toBeGreaterThan(snapshot);
		expect(snapshotSeq(transcript)).toBeGreaterThan(transcript.entries[1]!.seq!);
	});

	it("does not take back a sequence when the last entry is taken out", () => {
		let transcript: Transcript = { entries: [] };
		appendEntries(transcript, said("a", 10), said("b", 10));
		let removed = transcript.entries.pop()!;
		appendEntries(transcript, said("c", 10));
		expect(transcript.entries[1]!.seq).toBeGreaterThan(removed.seq!);
	});

	it("keeps the time and sequence an entry was stamped with when nothing came ahead of it", () => {
		let transcript: Transcript = { entries: [said("a", 10)] };
		appendEntries(transcript, said("b", 11));
		let next = said("c", 12);
		stampEntries(transcript, next);
		let stamped = { ts: next.ts, seq: next.seq };
		expect(appendEntries(transcript, next)).toBe(false);
		expect({ ts: next.ts, seq: next.seq }).toEqual(stamped);
	});

	it("moves an entry stamped before something else was appended, and says so", () => {
		let transcript: Transcript = { entries: [said("a", 10)] };
		let next = said("b", 10);
		stampEntries(transcript, next);
		appendEntries(transcript, said("meanwhile", 15));
		let before = next.seq!;
		expect(appendEntries(transcript, next)).toBe(true);
		expect(next.ts).toBe(15);
		expect(next.seq).toBeGreaterThan(before);
		expect(order(transcript)).toEqual(["a", "meanwhile", "b"]);
	});

	it("stamps an entry another transcript will hold too after that transcript's last", () => {
		let chat: Transcript = { entries: [] };
		appendEntries(chat, said("ahead", 100));
		let thread: Transcript = {
			entries: [],
			sharedWith: entry => entry.id === "shared" ? chat : undefined,
		};
		let shared = said("shared", 40);
		let own = said("own", 40);
		appendEntries(thread, own, shared);
		expect(own.ts).toBe(40);
		expect(shared.ts).toBe(100);
		expect(shared.seq).toBeGreaterThan(chat.entries[0]!.seq!);
		expect(appendEntries(chat, shared)).toBe(false);
		expect(order(chat)).toEqual(["ahead", "shared"]);
	});
});
