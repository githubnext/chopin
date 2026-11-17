import { describe, expect, it } from "bun:test";

import { interleave, localRows, placeOf } from "./chronology";
import { echoes } from "./delivery";
import { group } from "./model";

import type { Chat } from "@chopin/protocol";
import type { Local } from "./chronology";

let at = (hhmm: string) => {
	let [hours, minutes] = hhmm.split(":").map(Number);
	return 1_700_000_000 + hours! * 3600 + minutes! * 60;
};

function said(id: string, author: Chat.Author, time: string, text = id): Chat.Entry {
	return { id, author, text, ts: at(time) };
}

let chopin = { kind: "agent" } as const;
let alex = { kind: "member", handle: "alex" } as const;
let system = { kind: "system" } as const;

function rows(entries: Chat.Entry[], local: Local[]): string[] {
	return group(entries, undefined, [], undefined, local).flatMap(item =>
		item.kind === "messages"
			? item.messages.map(message => message.id)
			: [item.kind === "note" ? `note:${item.id}` : item.id]
	);
}

describe("an entry's place in time", () => {
	it("goes after every entry of its second or before", () => {
		let entries = [{ ts: 1 }, { ts: 2 }, { ts: 2 }, { ts: 4 }];
		expect(placeOf(entries, 0)).toBe(0);
		expect(placeOf(entries, 2)).toBe(3);
		expect(placeOf(entries, 3)).toBe(3);
		expect(placeOf(entries, 9)).toBe(4);
	});
});

describe("what only this browser shows", () => {
	it("keeps an Only visible to you note at 03:18 above what was said after it", () => {
		// The issue's transcript: the refusal at 03:18 stayed pinned below 03:29, 03:33 and 03:35.
		let entries = [
			said("asked", alex, "03:15"),
			said("reply-1", chopin, "03:16"),
			said("reply-2", chopin, "03:29"),
			said("answered-1", system, "03:30"),
			said("reply-3", chopin, "03:33"),
			said("answered-2", system, "03:34"),
		];
		let working = { id: "turn", started: at("03:35"), entryOffset: entries.length };
		let note: Local = { kind: "note", id: "refused", ts: at("03:18") };
		let groups = group(entries, working, [], undefined, [note]);
		expect(groups.map(item =>
			item.kind === "messages"
				? item.messages.map(message => message.id).join("+")
				: item.kind === "note"
				? "note"
				: item.id
		)).toEqual([
			"asked",
			"reply-1",
			"note",
			"reply-2",
			"answered-1",
			"reply-3",
			"answered-2",
			"turn",
		]);
	});

	it("puts a note after the entries of its own second, and last when it is the newest", () => {
		let entries = [said("a", alex, "03:18"), said("b", chopin, "03:18")];
		expect(rows(entries, [{ kind: "note", id: "n", ts: at("03:18") }])).toEqual([
			"a",
			"b",
			"note:n",
		]);
		expect(rows(entries, [{ kind: "note", id: "n", ts: at("03:19") }])).toEqual([
			"a",
			"b",
			"note:n",
		]);
	});

	it("places a message still sending by its own time, and shows a delivered one once", () => {
		let entries = [said("a", chopin, "03:10"), said("b", chopin, "03:20")];
		let sending = echoes([{
			payload: { requestId: "mine", text: "hello", references: [], to: "planner" },
			handle: "alex",
			ts: at("03:15"),
			failure: "Couldn't send.",
		}]);
		expect(rows(entries, localRows(sending, {}))).toEqual(["a", "mine", "b"]);
		let delivered = [entries[0]!, said("mine", alex, "03:15"), entries[1]!];
		expect(rows(delivered, localRows(sending, {}))).toEqual(["a", "mine", "b"]);
	});

	it("keeps a notice right under the message it answers, and drops one whose message is gone", () => {
		let notice = said("unanswered-m", system, "03:40", "No machine is connected to reply.");
		let entries = [said("m", alex, "03:10"), said("later", chopin, "03:20")];
		expect(rows(entries, localRows([], { m: notice }))).toEqual([
			"m",
			"unanswered-m",
			"later",
		]);
		expect(rows([said("later", chopin, "03:20")], localRows([], { m: notice }))).toEqual([
			"later",
		]);
	});

	it("leaves the offsets of a turn counting the server's entries", () => {
		let entries = [
			said("ask", alex, "03:00"),
			said("first", chopin, "03:01"),
			said("again", alex, "03:05"),
			said("second", chopin, "03:06"),
		];
		entries[3]!.tools = [{ id: "t", name: "read_plan", status: "running" }];
		let working = { id: "turn", started: at("03:05"), entryOffset: 3 };
		let groups = group(entries, working, [], undefined, [
			{ kind: "note", id: "n", ts: at("03:02") },
		]);
		let shown = groups.flatMap(item => item.kind === "messages" ? item.messages : []);
		expect(shown.find(message => message.working)?.id).toBe("second");
		expect(shown.find(message => message.id === "first")?.working).toBeUndefined();
	});

	it("merges by time in one pass, whatever the order local rows are given in", () => {
		let entries = [said("a", chopin, "03:10"), said("b", chopin, "03:30")];
		let late: Local = { kind: "entry", entry: said("late", alex, "03:20") };
		let early: Local = { kind: "entry", entry: said("early", alex, "03:05") };
		let ids = (local: Local[]) => interleave(entries, local, entry => entry).map(row => row.id);
		expect(ids([late, early])).toEqual(["early", "a", "late", "b"]);
		expect(ids([early, late])).toEqual(["early", "a", "late", "b"]);
	});
});
