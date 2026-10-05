import { describe, expect, it } from "bun:test";

import { group } from "./model";
import { initialTranscript, transcriptReducer } from "./transcript-state";

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
		let messages = group(state.entries, [], state.turn, state.completedWork).flatMap(item =>
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
		let messages = group(state.entries, [], state.turn, state.completedWork).flatMap(item =>
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
});
