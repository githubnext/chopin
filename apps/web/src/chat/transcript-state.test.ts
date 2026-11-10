import { describe, expect, it } from "bun:test";

import { group } from "./model";
import {
	initialTranscript,
	progressOf,
	silentRestart,
	transcriptReducer,
} from "./transcript-state";

import type { TranscriptState } from "./transcript-state";
import type { Chat } from "@chopin/protocol";

let turn: Chat.Turn = {
	id: "turn-1",
	handle: "ana",
	started: 1_700_000_001,
	entryOffset: 1,
	responded: false,
};

function entry(id: string, author: Chat.Author, text = ""): Chat.Entry {
	return { id, author, text, ts: 1_700_000_001 };
}

describe("transcript work retention", () => {
	it("keeps a prose anchor and its later tool together on the first completed render", () => {
		let state = transcriptReducer(initialTranscript, {
			kind: "history",
			entries: [entry("prompt", { kind: "member", handle: "ana" })],
			turn,
		});
		state = transcriptReducer(state, {
			kind: "message",
			entry: entry("prose", { kind: "agent" }, "I will inspect this."),
		});
		state = transcriptReducer(state, {
			kind: "message",
			entry: entry("tool-entry", { kind: "agent" }),
		});
		state = transcriptReducer(state, {
			kind: "tool",
			entryId: "tool-entry",
			activity: { id: "read", name: "read_plan", status: "running" },
		});
		state = transcriptReducer(state, { kind: "turn" });

		expect(state.completedWork).toEqual([{
			turnId: "turn-1",
			entryOffset: 1,
			endOffset: 3,
			anchorId: "prose",
		}]);
		let messages = group(state.entries, state.turn, state.completedWork).flatMap(item =>
			item.kind === "messages" ? item.messages : []
		);
		expect(messages.find(message => message.id === "prose")?.tools).toMatchObject([{
			id: "read",
		}]);
		expect(messages.find(message => message.id === "tool-entry")?.tools).toBeUndefined();
	});

	it("keeps the completed anchor through a late result and a reconnect history", () => {
		let entries = [
			entry("prompt", { kind: "member", handle: "ana" }),
			entry("prose", { kind: "agent" }, "I will inspect this."),
			{
				...entry("tool-entry", { kind: "agent" }),
				tools: [{ id: "read", name: "read_plan", status: "running" as const }],
			},
		];
		let state = transcriptReducer(initialTranscript, { kind: "history", entries, turn });
		state = transcriptReducer(state, { kind: "turn" });
		state = transcriptReducer(state, { kind: "history", entries: state.entries });
		state = transcriptReducer(state, {
			kind: "tool",
			entryId: "tool-entry",
			activity: { id: "read", name: "read_plan", status: "done", result: "Read it." },
		});

		expect(state.completedWork).toMatchObject([{ anchorId: "prose", endOffset: 3 }]);
		let messages = group(state.entries, state.turn, state.completedWork).flatMap(item =>
			item.kind === "messages" ? item.messages : []
		);
		expect(messages.find(message => message.id === "prose")?.tools).toMatchObject([{
			status: "done",
			result: "Read it.",
		}]);
		let other = transcriptReducer(state, {
			kind: "history",
			entries: [entry("another-room", { kind: "member", handle: "sam" })],
		});
		expect(other.completedWork).toEqual([]);
	});

	it("does not pull another finished turn into an offline turn's work span", () => {
		let local = [
			entry("prompt-a", { kind: "member", handle: "ana" }),
			entry("prose-a", { kind: "agent" }, "Checking A."),
			{
				...entry("tool-a", { kind: "agent" }),
				tools: [{ id: "read-a", name: "read_plan", status: "done" as const }],
			},
		];
		let state = transcriptReducer(initialTranscript, { kind: "history", entries: local, turn });
		let history = [
			...local,
			entry("prompt-b", { kind: "member", handle: "sam" }),
			{
				...entry("tool-b", { kind: "agent" }),
				tools: [{ id: "read-b", name: "read_plan", status: "done" as const }],
			},
		];
		state = transcriptReducer(state, { kind: "history", entries: history });

		expect(state.completedWork).toMatchObject([{ anchorId: "prose-a", endOffset: 3 }]);
		let messages = group(state.entries, state.turn, state.completedWork).flatMap(item =>
			item.kind === "messages" ? item.messages : []
		);
		expect(messages.find(message => message.id === "prose-a")?.tools).toMatchObject([{
			id: "read-a",
		}]);
		expect(messages.find(message => message.id === "tool-b")?.tools).toMatchObject([{
			id: "read-b",
		}]);
	});
});

describe("how a turn in progress is shown while its connection is lost", () => {
	function working() {
		let state = transcriptReducer(initialTranscript, {
			kind: "history",
			entries: [entry("prompt", { kind: "member", handle: "ana" })],
			turn,
		});
		return transcriptReducer(state, {
			kind: "message",
			entry: entry("prose", { kind: "agent" }, "I will inspect this."),
		});
	}

	it("goes on showing a turn as working while its connection is current", () => {
		let shown = progressOf(working(), true, false);
		expect(shown.working?.id).toBe("turn-1");
		expect(shown.suspended).toBeUndefined();
	});

	it("goes on showing it as working while a restart is waited out in silence, so a restart leaves no trace", () => {
		let shown = progressOf(working(), false, true);
		expect(shown.working?.id).toBe("turn-1");
		expect(shown.suspended).toBeUndefined();
	});

	it("marks it disconnected as soon as a connection that was not a restart is gone", () => {
		let shown = progressOf(working(), false, false);
		expect(shown.working).toBeUndefined();
		expect(shown.suspended).toEqual({
			turnId: "turn-1",
			entryOffset: 1,
			endOffset: 2,
			anchorId: "prose",
		});
	});

	it("has nothing to mark before the turn has written anything", () => {
		let state = transcriptReducer(initialTranscript, {
			kind: "history",
			entries: [entry("prompt", { kind: "member", handle: "ana" })],
			turn,
		});
		expect(progressOf(state, false, false)).toEqual({});
		expect(progressOf(initialTranscript, false, false)).toEqual({});
	});
});

describe("when a restart is waited out in silence", () => {
	it("begins with a loss the server said was a restart, and with no other", () => {
		expect(silentRestart(false, true, false, false)).toBe(true);
		expect(silentRestart(false, false, false, false)).toBe(false);
	});

	it("lasts through the moment after the connection opens, until the transcript is current", () => {
		// The connection is back, so it no longer says restarting, but the history has not come.
		expect(silentRestart(true, false, false, false)).toBe(true);
		expect(silentRestart(true, false, true, false)).toBe(false);
	});

	it("ends once the connection is spoken of, and does not begin again in that outage", () => {
		expect(silentRestart(true, true, false, true)).toBe(false);
		expect(silentRestart(false, true, false, true)).toBe(false);
		// Back after a long outage: the next loss's marker is cleared, and nothing is silent.
		expect(silentRestart(false, false, false, false)).toBe(false);
	});
});

describe("a message removed before it was delivered", () => {
	it("leaves the others where they were, and moves the turn and the finished work that count entries up", () => {
		let state = transcriptReducer(initialTranscript, {
			kind: "history",
			entries: [
				entry("one", { kind: "member", handle: "ana" }, "one"),
				entry("two", { kind: "member", handle: "ana" }, "two"),
				entry("reply", { kind: "agent" }, "On it."),
			],
			turn: { ...turn, entryOffset: 2 },
		});
		expect(state.turn?.entryOffset).toBe(2);
		state = transcriptReducer(state, { kind: "removed", id: "two" });
		expect(state.entries.map(item => item.id)).toEqual(["one", "reply"]);
		expect(state.turn?.entryOffset).toBe(1);
		expect(state.activeAnchorId).toBe("reply");
		// An entry after the turn's start does not move it, and one that is gone changes nothing.
		let later = transcriptReducer(state, {
			kind: "message",
			entry: entry("three", { kind: "member", handle: "ana" }, "three"),
		});
		later = transcriptReducer(later, { kind: "removed", id: "three" });
		expect(later.turn?.entryOffset).toBe(1);
		expect(transcriptReducer(later, { kind: "removed", id: "nothing" })).toBe(later);
	});
});

describe("a message that waited for its turn, once the turn starts", () => {
	let ana: Chat.Author = { kind: "member", handle: "ana" };
	let waiting = (id: string, delivered = false): Chat.Entry => ({
		...entry(id, ana, id),
		deliveryState: delivered ? "delivered" : "sent",
	});
	// What is said, in order; the new turn's own working row has no words yet.
	let texts = (state: typeof initialTranscript, hidden: string[]) =>
		group(state.entries, state.turn, state.completedWork, undefined, new Set(hidden))
			.flatMap(item => item.kind === "messages" ? item.messages.map(message => message.text) : [])
			.filter(Boolean);

	it("joins the end after the reply the reader was watching, and nothing already drawn moves", () => {
		// Two messages were sent behind the first turn, which is still running.
		let state = transcriptReducer(initialTranscript, {
			kind: "history",
			entries: [entry("first", ana, "first"), waiting("second"), waiting("third")],
			turn: { ...turn, entryOffset: 1 },
		});
		state = transcriptReducer(state, {
			kind: "message",
			entry: entry("answer", { kind: "agent" }, "answer 1"),
		});
		let hidden = ["second", "third"];
		let before = texts(state, hidden);
		expect(before).toEqual(["first", "answer 1"]);

		// The second one's turn starts: its entry is announced as moved, and then the new turn.
		state = transcriptReducer(state, {
			kind: "message",
			entry: waiting("second", true),
			moved: true,
		});
		expect(state.entries.map(item => item.id)).toEqual(["first", "third", "answer", "second"]);
		expect(texts(state, hidden)).toEqual([...before, "second"]);
		state = transcriptReducer(state, {
			kind: "turn",
			turn: { ...turn, id: "turn-2", entryOffset: 4 },
		});
		expect(state.completedWork).toMatchObject([{ turnId: "turn-1", entryOffset: 1, endOffset: 4 }]);
		expect(texts(state, ["third"])).toEqual(["first", "answer 1", "second"]);

		// The third follows behind the second and its answer, the same way.
		state = transcriptReducer(state, {
			kind: "message",
			entry: entry("answer-2", { kind: "agent" }, "answer 2"),
		});
		state = transcriptReducer(state, {
			kind: "message",
			entry: waiting("third", true),
			moved: true,
		});
		expect(texts(state, [])).toEqual(["first", "answer 1", "second", "answer 2", "third"]);
	});

	it("moves the turn and the finished work that count entries from the start, as a removal does", () => {
		let state: TranscriptState = {
			...initialTranscript,
			entries: [
				entry("one", ana, "one"),
				waiting("two"),
				entry("reply", { kind: "agent" }, "reply"),
				entry("three", ana, "three"),
			],
			turn: { ...turn, entryOffset: 3 },
			completedWork: [{ turnId: "turn-0", entryOffset: 2, endOffset: 3, anchorId: "reply" }],
		};
		state = transcriptReducer(state, { kind: "message", entry: waiting("two", true), moved: true });
		expect(state.entries.map(item => item.id)).toEqual(["one", "reply", "three", "two"]);
		expect(state.turn?.entryOffset).toBe(2);
		expect(state.completedWork).toEqual([
			{ turnId: "turn-0", entryOffset: 1, endOffset: 2, anchorId: "reply" },
		]);
	});

	it("is replaced where it is unless it was told to move, and added when it is not there", () => {
		let state = transcriptReducer(initialTranscript, {
			kind: "history",
			entries: [waiting("two"), entry("reply", { kind: "agent" }, "reply")],
		});
		let replaced = transcriptReducer(state, { kind: "message", entry: waiting("two", true) });
		expect(replaced.entries.map(item => item.id)).toEqual(["two", "reply"]);
		let last = transcriptReducer(replaced, {
			kind: "message",
			entry: waiting("reply", true),
			moved: true,
		});
		expect(last.entries.map(item => item.id)).toEqual(["two", "reply"]);
		let added = transcriptReducer(state, {
			kind: "message",
			entry: waiting("new", true),
			moved: true,
		});
		expect(added.entries.map(item => item.id)).toEqual(["two", "reply", "new"]);
	});
});
