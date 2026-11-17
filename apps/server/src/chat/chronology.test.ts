import { describe, expect, it } from "bun:test";

import { appendEntries } from "./chronology";

import type { Chat as Wire } from "@chopin/protocol";

function said(id: string, ts: number): Wire.Entry {
	return { id, author: { kind: "system" }, text: id, ts };
}

describe("a transcript's entries in time", () => {
	it("adds entries at the end, those of one second in the order they came", () => {
		let entries = [said("a", 10)];
		appendEntries(entries, said("b", 10), said("c", 12));
		expect(entries.map(entry => [entry.id, entry.ts])).toEqual([["a", 10], ["b", 10], ["c", 12]]);
	});

	it("never puts an entry before the second of the one ahead of it", () => {
		let entries = [said("a", 20)];
		let late = said("made-earlier", 18);
		appendEntries(entries, late);
		expect(late.ts).toBe(20);
		expect(entries.map(entry => entry.ts)).toEqual([20, 20]);
	});
});
