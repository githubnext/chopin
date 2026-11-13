import { describe, expect, it } from "bun:test";

import { group } from "./model";
import {
	initialTranscript,
	offersStop,
	progressOf,
	shownWork,
	silentRestart,
	transcriptReducer,
} from "./transcript-state";

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

function image(src: string): Chat.Image {
	return { src, alt: src, width: 4, height: 3, generated: true };
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

describe("a quiet turn: nothing left of it is for people to watch", () => {
	let prompt = entry("prompt", { kind: "member", handle: "ana" });
	let answer = entry("answer", { kind: "agent" }, "An iterator yields one item at a time.");

	function rows(
		entries: Chat.Entry[],
		quiet: Chat.Turn,
		completed = initialTranscript.completedWork,
	) {
		let state = transcriptReducer(initialTranscript, { kind: "history", entries, turn: quiet });
		let shown = progressOf(state, true, false);
		return {
			shown,
			messages: group(state.entries, shown.working, shownWork(completed, shown.settled)).flatMap(
				item => item.kind === "messages" ? item.messages : [],
			),
		};
	}

	it("draws a background job's turn as nothing: no row, no working message", () => {
		// The answer belongs to the turn that ended; the job's turn begins after it.
		let { shown, messages } = rows([prompt, answer], { ...turn, entryOffset: 2, quiet: true });
		expect(shown.working).toBeUndefined();
		expect(shown.settled).toBeUndefined();
		expect(messages.map(message => message.id)).toEqual(["prompt", "answer"]);
		expect(messages.some(message => message.working)).toBe(false);
	});

	it("draws an answer whose check is still running as an ended turn, its tools kept", () => {
		let tooled = {
			...answer,
			tools: [{ id: "read", name: "read_plan", status: "done" as const, result: "Read it." }],
		};
		let { shown, messages } = rows([prompt, tooled], { ...turn, quiet: true });
		expect(shown.working).toBeUndefined();
		expect(shown.settled).toEqual({
			turnId: "turn-1",
			entryOffset: 1,
			endOffset: 2,
			anchorId: "answer",
		});
		let shownAnswer = messages.find(message => message.id === "answer");
		expect(shownAnswer?.working).toBeUndefined();
		expect(shownAnswer?.tools).toMatchObject([{ id: "read", status: "done" }]);
	});

	it("goes on showing work once a repair step makes the turn work again", () => {
		let { shown } = rows([prompt, answer], turn);
		expect(shown.working?.id).toBe("turn-1");
		expect(shown.settled).toBeUndefined();
	});

	it("offers Stop for a quiet turn only when a message was refused because of it", () => {
		let quiet = { ...turn, quiet: true };
		expect(offersStop(true, turn, false)).toBe(true);
		expect(offersStop(true, quiet, false)).toBe(false);
		expect(offersStop(true, quiet, true)).toBe(true);
		expect(offersStop(false, undefined, false)).toBe(false);
		// A server that does not say which turn runs keeps its Stop.
		expect(offersStop(true, undefined, false)).toBe(true);
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

describe("a tool call id a remote client reuses in a later turn", () => {
	it("keeps each turn's tool and images on its own message", () => {
		let state = transcriptReducer(initialTranscript, {
			kind: "history",
			entries: [{
				...entry("first", { kind: "agent" }),
				tools: [{ id: "call-1", name: "make_image", status: "done" }],
				images: [image("/images/first.png")],
			}],
		});
		state = transcriptReducer(state, {
			kind: "message",
			entry: entry("second", { kind: "agent" }),
		});
		state = transcriptReducer(state, {
			kind: "tool",
			entryId: "second",
			activity: { id: "call-1", name: "make_image", status: "running" },
		});
		state = transcriptReducer(state, {
			kind: "message",
			entry: {
				...entry("second", { kind: "agent" }),
				tools: [{ id: "call-1", name: "make_image", status: "done" }],
				images: [image("/images/second.png")],
			},
		});

		let [first, second] = state.entries;
		expect(first?.tools).toEqual([{ id: "call-1", name: "make_image", status: "done" }]);
		expect(first?.images?.map(item => item.src)).toEqual(["/images/first.png"]);
		expect(second?.tools).toEqual([{ id: "call-1", name: "make_image", status: "done" }]);
		expect(second?.images?.map(item => item.src)).toEqual(["/images/second.png"]);
	});

	it("draws the images of each message on that message", () => {
		let groups = group([
			{
				...entry("first", { kind: "agent" }, "One."),
				images: [{ src: "/images/first.png", alt: "first", width: 4, height: 3 }],
			},
			{
				...entry("second", { kind: "agent" }, "Two."),
				images: [{ src: "/images/second.png", alt: "second", width: 4, height: 3 }],
			},
		]);
		let messages = groups.flatMap(item => item.kind === "messages" ? item.messages : []);

		expect(messages.map(message => message.images?.map(item => item.alt))).toEqual([
			["first"],
			["second"],
		]);
	});
});

describe("message reactions", () => {
	let reaction = (emoji: string, ...handles: string[]) => ({ emoji, handles });

	it("replaces one message's reactions and leaves every other message as it was", () => {
		let state = transcriptReducer(initialTranscript, {
			kind: "history",
			entries: [entry("a", { kind: "agent" }, "one"), entry("b", { kind: "agent" }, "two")],
		});
		let next = transcriptReducer(state, {
			kind: "reactions",
			id: "a",
			reactions: [reaction("❓", "ana"), reaction("✅", "ana", "mina")],
		});
		expect(next.entries[0]!.reactions).toEqual([
			reaction("❓", "ana"),
			reaction("✅", "ana", "mina"),
		]);
		expect(next.entries[1]).toBe(state.entries[1]!);
		expect(next.turn).toBe(state.turn);
	});

	it("clears them when the last one is taken back, and ignores a message it does not have", () => {
		let state = transcriptReducer(initialTranscript, {
			kind: "history",
			entries: [{ ...entry("a", { kind: "agent" }, "one"), reactions: [reaction("✅", "ana")] }],
		});
		let cleared = transcriptReducer(state, { kind: "reactions", id: "a", reactions: [] });
		expect(cleared.entries[0]!.reactions).toBeUndefined();
		expect(
			transcriptReducer(state, { kind: "reactions", id: "gone", reactions: [reaction("✅", "x")] }),
		)
			.toBe(state);
	});

	it("keeps a message's reactions when its entry is replaced by a streamed one", () => {
		let state = transcriptReducer(initialTranscript, {
			kind: "history",
			entries: [entry("a", { kind: "agent" }, "one")],
		});
		let reacted = transcriptReducer(state, {
			kind: "reactions",
			id: "a",
			reactions: [reaction("👎", "ana")],
		});
		let finished = transcriptReducer(reacted, {
			kind: "message",
			entry: { ...entry("a", { kind: "agent" }, "one more"), reactions: [reaction("👎", "ana")] },
		});
		expect(finished.entries[0]!.reactions).toEqual([reaction("👎", "ana")]);
	});
});

describe("a retried reply", () => {
	it("drops the failed attempt's entries and the work they showed, and keeps the message", () => {
		let state = transcriptReducer(initialTranscript, {
			kind: "history",
			entries: [entry("prompt", { kind: "member", handle: "ana" })],
			turn,
		});
		state = transcriptReducer(state, {
			kind: "message",
			entry: entry("partial", { kind: "agent" }, "Partial draft."),
		});
		state = transcriptReducer(state, { kind: "turn" });
		state = transcriptReducer(state, {
			kind: "message",
			entry: entry("failure", { kind: "system" }, "503 Service Unavailable"),
		});
		expect(state.completedWork.map(item => item.anchorId)).toEqual(["partial"]);

		state = transcriptReducer(state, { kind: "removed", ids: ["partial", "failure"] });
		expect(state.entries.map(item => item.id)).toEqual(["prompt"]);
		expect(state.completedWork).toEqual([]);
		// Ids it no longer has change nothing.
		expect(transcriptReducer(state, { kind: "removed", ids: ["partial"] })).toBe(state);
	});
});
