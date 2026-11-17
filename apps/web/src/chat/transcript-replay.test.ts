import { describe, expect, it } from "bun:test";

import { initialTranscript, transcriptReducer } from "./transcript-state";

import type { Chat } from "@chopin/protocol";
import type { TranscriptAction, TranscriptState } from "./transcript-state";

/** A small seeded generator, so a failing case can be run again. */
function random(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

type Stream = { id: string; actions: TranscriptAction[] };

/**
 * What a server says over a transcript's life, as it says it: each entry's frames in order, and
 * the entries a Retry took out. `ties` gives several entries the same second.
 */
function server(next: () => number, count: number, ties: boolean) {
	let entries: Chat.Entry[] = [];
	let streams: Stream[] = [];
	let removed: string[] = [];
	let snapshots: Chat.Entry[][] = [];
	let ts = 1_700_000_000;
	for (let index = 0; index < count; index++) {
		ts += ties && next() < 0.5 ? 0 : 1 + Math.floor(next() * 30);
		let id = `e${index}`;
		let actions: TranscriptAction[] = [];
		if (next() < 0.4) {
			let entry: Chat.Entry = { id, author: { kind: "member", handle: "ana" }, text: id, ts };
			entries.push(entry);
			actions.push({ kind: "message", entry: { ...entry } });
		} else {
			let words = ["Look", "ing at", " the", " plan", " now."].slice(0, 2 + Math.floor(next() * 4));
			let entry: Chat.Entry = {
				id,
				author: { kind: "agent" },
				text: words[0]!,
				ts,
				streaming: true,
			};
			entries.push(entry);
			actions.push({ kind: "message", entry: { ...entry } });
			for (let piece of words.slice(1)) {
				actions.push({ kind: "delta", id, text: piece, at: entry.text.length });
				entry.text += piece;
			}
			if (next() < 0.5) {
				let activity: Chat.Activity = { id: `${id}-tool`, name: "read_plan", status: "done" };
				entry.tools = [activity];
				actions.push({ kind: "tool", entryId: id, activity });
			}
			delete entry.streaming;
			actions.push({ kind: "message", entry: structuredClone(entry) });
			if (next() < 0.25) {
				removed.push(id);
				actions.push({ kind: "removed", ids: [id] });
			}
		}
		streams.push({ id, actions });
		snapshots.push(structuredClone(entries.filter(entry => !removed.includes(entry.id))));
	}
	return {
		final: entries.filter(entry => !removed.includes(entry.id)),
		streams,
		snapshots,
	};
}

/**
 * One delivery of every frame: frames of different entries in any order, each entry's own in the
 * order it was said, a removal anywhere, and any frame again, at once or later.
 */
function delivered(next: () => number, streams: Stream[]): TranscriptAction[] {
	let queues = streams.map(stream => {
		let removal = stream.actions.filter(action => action.kind === "removed");
		let rest = stream.actions.filter(action => action.kind !== "removed");
		return { rest, removal };
	});
	let out: TranscriptAction[] = [];
	let pending = queues.flatMap(queue => queue.removal);
	while (queues.some(queue => queue.rest.length) || pending.length) {
		let live = queues.filter(queue => queue.rest.length);
		if (pending.length && (!live.length || next() < 0.1)) {
			out.push(pending.splice(Math.floor(next() * pending.length), 1)[0]!);
			continue;
		}
		let queue = live[Math.floor(next() * live.length)]!;
		out.push(queue.rest.shift()!);
	}
	let keyed = out.map((action, index) => ({ action, key: index }));
	for (let [index, action] of out.entries()) {
		if (next() < 0.3) keyed.push({ action, key: index + next() * (out.length - index) });
	}
	return keyed.sort((a, b) => a.key - b.key).map(item => item.action);
}

function apply(state: TranscriptState, actions: TranscriptAction[]): TranscriptState {
	return actions.reduce(transcriptReducer, state);
}

function shown(state: TranscriptState): Chat.Entry[] {
	return state.entries;
}

describe("a transcript applied in any order", () => {
	it("is the server's, whatever order its entries' frames come in, and however often", () => {
		for (let seed = 1; seed <= 300; seed++) {
			let next = random(seed);
			let { final, streams } = server(next, 3 + Math.floor(next() * 10), false);
			let state = apply(initialTranscript, delivered(next, streams));
			expect({ seed, entries: shown(state) }).toEqual({ seed, entries: final });
		}
	});

	it("keeps entries of the same second in the server's order, and a frame said twice changes nothing", () => {
		for (let seed = 1; seed <= 200; seed++) {
			let next = random(seed);
			let { final, streams } = server(next, 3 + Math.floor(next() * 10), true);
			let once = initialTranscript;
			let twice = initialTranscript;
			for (let action of streams.flatMap(stream => stream.actions)) {
				once = transcriptReducer(once, action);
				twice = apply(twice, next() < 0.5 ? [action, action] : [action]);
				expect({ seed, entries: shown(twice) }).toEqual({ seed, entries: shown(once) });
			}
			expect({ seed, entries: shown(twice) }).toEqual({ seed, entries: final });
		}
	});

	it("is the server's after a reconnect that lost frames, and after its history comes twice", () => {
		for (let seed = 1; seed <= 200; seed++) {
			let next = random(seed);
			let { final, streams, snapshots } = server(next, 4 + Math.floor(next() * 8), true);
			let cut = Math.floor(next() * streams.length);
			let before = streams.slice(0, cut).flatMap(stream => stream.actions)
				.filter(() => next() < 0.6);
			let history: TranscriptAction = {
				kind: "history",
				entries: structuredClone(cut === 0 ? [] : snapshots[cut - 1]!),
			};
			let after = streams.slice(cut).flatMap(stream => stream.actions)
				.flatMap(action => next() < 0.3 ? [action, action] : [action]);
			let state = apply(initialTranscript, [...before, history, history, ...after]);
			expect({ seed, entries: shown(state) }).toEqual({ seed, entries: final });
		}
	});

	it("does not bring back an entry a Retry took out when a copy of it arrives late", () => {
		let entry: Chat.Entry = { id: "failed", author: { kind: "agent" }, text: "Sorry", ts: 1 };
		let state = apply(initialTranscript, [
			{ kind: "removed", ids: ["failed"] },
			{ kind: "message", entry },
			{ kind: "removed", ids: ["failed"] },
		]);
		expect(state.entries).toEqual([]);
		state = apply(state, [{ kind: "history", entries: [] }, { kind: "message", entry }]);
		expect(state.entries).toEqual([]);
	});

	it("does not add a streamed piece twice", () => {
		let entry: Chat.Entry = {
			id: "a",
			author: { kind: "agent" },
			text: "Hel",
			ts: 1,
			streaming: true,
		};
		let piece: TranscriptAction = { kind: "delta", id: "a", text: "lo", at: 3 };
		let state = apply(initialTranscript, [{ kind: "message", entry }, piece, piece]);
		expect(state.entries[0]!.text).toBe("Hello");
		state = apply(state, [{ kind: "message", entry }]);
		expect(state.entries[0]!.text).toBe("Hello");
	});
});
