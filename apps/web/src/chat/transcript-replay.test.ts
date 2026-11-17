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

function apply(state: TranscriptState, actions: TranscriptAction[]): TranscriptState {
	return actions.reduce(transcriptReducer, state);
}

function pick<T>(next: () => number, items: readonly T[]): T {
	return items[Math.floor(next() * items.length)]!;
}

/**
 * What a server says over a transcript's life, in the order it says it: entries appended with a
 * time that never goes back and a sequence that only grows, often several in one second; agent
 * entries streamed in pieces, or holding only tool calls, with tool calls that start, report
 * partial results and finish, each report the whole call with its place and revision; reactions given and taken
 * back; entries a Retry takes out, which moves the sequence past them; and copies of the whole
 * transcript (`history`) along the way, which give out no sequence.
 */
function server(next: () => number, count: number) {
	let entries: Chat.Entry[] = [];
	let frames: TranscriptAction[] = [];
	let removed = new Set<string>();
	let ts = 1_700_000_000;
	let seq = 0;
	let snapshot = () => {
		frames.push({
			kind: "history",
			entries: structuredClone(entries.filter(entry => !removed.has(entry.id))),
			seq,
		});
	};
	let react = () => {
		let shown = entries.filter(entry => !removed.has(entry.id) && entry.author.kind !== "system");
		if (!shown.length) return;
		let entry = pick(next, shown);
		let reactions = next() < 0.3
			? []
			: [{ emoji: pick(next, ["✅", "👀", "🎉"]), handles: ["ana"] }];
		entry.reactionsSeq = (entry.reactionsSeq ?? 0) + 1;
		if (reactions.length) entry.reactions = reactions;
		else delete entry.reactions;
		frames.push({
			kind: "reactions",
			id: entry.id,
			reactions: structuredClone(reactions),
			reactionsSeq: entry.reactionsSeq,
		});
	};
	let report = (entry: Chat.Entry, change: Chat.Activity) => {
		let tools = entry.tools ??= [];
		let at = tools.findIndex(tool => tool.id === change.id);
		let before = tools[at];
		let sent: Chat.Activity = {
			...before,
			...change,
			order: before ? before.order! : tools.length,
			rev: (before?.rev ?? 0) + 1,
		};
		if (before) tools[at] = sent;
		else tools.push(sent);
		frames.push({ kind: "tool", entryId: entry.id, activity: structuredClone(sent) });
		if (next() < 0.3) frames.push({ kind: "message", entry: structuredClone(entry) });
		if (next() < 0.15) snapshot();
	};
	for (let index = 0; index < count; index++) {
		ts += next() < 0.6 ? 0 : 1 + Math.floor(next() * 30);
		seq += 1 + Math.floor(next() * 3);
		let id = `e${index}`;
		let kind = next();
		if (kind < 0.35) {
			let entry: Chat.Entry = { id, author: { kind: "member", handle: "ana" }, text: id, ts, seq };
			entries.push(entry);
			frames.push({ kind: "message", entry: structuredClone(entry) });
		} else {
			let toolOnly = kind < 0.55;
			let words = ["Look", "ing at", " the", " plan", " now."].slice(0, 2 + Math.floor(next() * 4));
			let entry: Chat.Entry = toolOnly
				? { id, author: { kind: "agent" }, text: "", ts, seq, tools: [] }
				: { id, author: { kind: "agent" }, text: words[0]!, ts, seq, streaming: true };
			entries.push(entry);
			frames.push({ kind: "message", entry: structuredClone(entry) });
			if (!toolOnly) {
				for (let piece of words.slice(1)) {
					frames.push({ kind: "delta", id, text: piece, at: entry.text.length });
					entry.text += piece;
					if (next() < 0.2) snapshot();
				}
			}
			let calls = (toolOnly ? 1 : 0) + Math.floor(next() * 3);
			for (let call = 0; call < calls; call++) {
				let tool = `${id}-t${call}`;
				report(entry, { id: tool, name: "read_plan", status: "running", startedAt: call });
				for (let read = 1; read <= Math.floor(next() * 3); read++) {
					report(entry, {
						id: tool,
						name: "read_plan",
						status: "running",
						result: `Read ${read} file${read === 1 ? "" : "s"}`,
					});
				}
				report(entry, {
					id: tool,
					name: "read_plan",
					status: next() < 0.8 ? "done" : "failed",
					took: 5,
				});
			}
			if (!toolOnly) {
				delete entry.streaming;
				frames.push({ kind: "message", entry: structuredClone(entry) });
			}
			if (next() < 0.25) {
				removed.add(id);
				seq += 1;
				frames.push({ kind: "removed", ids: [id] });
			}
		}
		if (next() < 0.3) react();
		if (next() < 0.25) snapshot();
	}
	if (next() < 0.5) react();
	return { final: entries.filter(entry => !removed.has(entry.id)), frames };
}

/** Every frame at least once, in any order, some of them again at any later point. */
function shuffled(next: () => number, frames: readonly TranscriptAction[]): TranscriptAction[] {
	let keyed = frames.map(action => ({ action, key: next() }));
	for (let action of frames) {
		if (next() < 0.3) keyed.push({ action, key: next() });
	}
	return keyed.sort((a, b) => a.key - b.key).map(item => item.action);
}

describe("a transcript applied in any order", () => {
	it("is the server's, whatever order every frame comes in, and however often", () => {
		for (let seed = 1; seed <= 400; seed++) {
			let next = random(seed);
			let { final, frames } = server(next, 3 + Math.floor(next() * 12));
			let state = apply(initialTranscript, shuffled(next, frames));
			expect({ seed, entries: state.entries }).toEqual({ seed, entries: final });
		}
	});

	it("is the server's when each frame is applied twice where it falls", () => {
		for (let seed = 1; seed <= 200; seed++) {
			let next = random(seed);
			let { final, frames } = server(next, 3 + Math.floor(next() * 12));
			let once = initialTranscript;
			let twice = initialTranscript;
			for (let action of frames) {
				once = transcriptReducer(once, action);
				twice = apply(twice, [action, action]);
				expect({ seed, entries: twice.entries }).toEqual({ seed, entries: once.entries });
			}
			expect({ seed, entries: twice.entries }).toEqual({ seed, entries: final });
		}
	});

	it("is the server's after a reconnect that lost frames and then hears them late", () => {
		for (let seed = 1; seed <= 200; seed++) {
			let next = random(seed);
			let { final, frames } = server(next, 4 + Math.floor(next() * 10));
			let histories = frames.filter(action => action.kind === "history");
			let cut = Math.floor(next() * frames.length);
			let before = frames.slice(0, cut).filter(() => next() < 0.6);
			let after = frames.slice(cut);
			let latest = histories.at(-1);
			let state = apply(initialTranscript, [
				...before,
				...(latest ? [latest] : []),
				...after,
				...shuffled(next, frames.slice(0, cut)),
			]);
			expect({ seed, entries: state.entries }).toEqual({ seed, entries: final });
		}
	});
});

function agent(id: string, ts: number, seq: number, text: string, more: Partial<Chat.Entry> = {}) {
	return { id, author: { kind: "agent" }, text, ts, seq, ...more } satisfies Chat.Entry;
}

describe("a transcript's regressions", () => {
	it("puts entries of one second in the server's order whichever comes first", () => {
		let a = agent("a", 100, 1, "first");
		let b = agent("b", 100, 2, "second");
		let state = apply(initialTranscript, [{ kind: "message", entry: b }, {
			kind: "message",
			entry: a,
		}]);
		expect(state.entries.map(entry => entry.id)).toEqual(["a", "b"]);
	});

	it("does not bring back an entry a Retry took out when a history that had it comes again", () => {
		let a = agent("a", 1, 1, "Sorry");
		let history: TranscriptAction = { kind: "history", entries: [a], seq: 2 };
		let state = apply(initialTranscript, [history, { kind: "removed", ids: ["a"] }, history]);
		expect(state.entries).toEqual([]);
		state = apply(state, [{ kind: "message", entry: a }]);
		expect(state.entries).toEqual([]);
	});

	it("drops an entry taken out while the connection was gone, and does not take it back late", () => {
		let a = agent("a", 1, 1, "kept");
		let failed = agent("failed", 1, 2, "Sorry");
		let state = apply(initialTranscript, [
			{ kind: "message", entry: a },
			{ kind: "message", entry: failed },
			{ kind: "history", entries: [a], seq: 5 },
			{ kind: "message", entry: failed },
		]);
		expect(state.entries.map(entry => entry.id)).toEqual(["a"]);
	});

	it("ignores a history older than one applied, and keeps what came after the newer one", () => {
		let a = agent("a", 1, 1, "Hel", { streaming: true });
		let b = agent("b", 2, 7, "later");
		let state = apply(initialTranscript, [
			{ kind: "history", entries: [{ ...a, text: "Hello", streaming: undefined }], seq: 6 },
			{ kind: "message", entry: b },
			{ kind: "history", entries: [a], seq: 3 },
		]);
		expect(state.entries.map(entry => [entry.id, entry.text])).toEqual([["a", "Hello"], [
			"b",
			"later",
		]]);
	});

	it("keeps a streamed piece that arrives before the text ahead of it", () => {
		let entry = agent("a", 1, 1, "Hel", { streaming: true });
		let state = apply(initialTranscript, [
			{ kind: "message", entry },
			{ kind: "delta", id: "a", text: " world", at: 5 },
			{ kind: "delta", id: "a", text: "lo", at: 3 },
		]);
		expect(state.entries[0]!.text).toBe("Hello world");
	});

	it("does not add a streamed piece twice", () => {
		let entry = agent("a", 1, 1, "Hel", { streaming: true });
		let piece: TranscriptAction = { kind: "delta", id: "a", text: "lo", at: 3 };
		let state = apply(initialTranscript, [{ kind: "message", entry }, piece, piece]);
		expect(state.entries[0]!.text).toBe("Hello");
		state = apply(state, [{ kind: "message", entry }]);
		expect(state.entries[0]!.text).toBe("Hello");
	});

	it("keeps reactions when an older copy of the message arrives again", () => {
		let entry = agent("a", 1, 1, "Done.");
		let state = apply(initialTranscript, [
			{ kind: "message", entry },
			{
				kind: "reactions",
				id: "a",
				reactions: [{ emoji: "✅", handles: ["ana"] }],
				reactionsSeq: 3,
			},
			{ kind: "message", entry },
			{ kind: "reactions", id: "a", reactions: [], reactionsSeq: 2 },
		]);
		expect(state.entries[0]!.reactions).toEqual([{ emoji: "✅", handles: ["ana"] }]);
	});

	it("keeps finished tool calls when an older copy of the entry arrives again", () => {
		let original = agent("a", 1, 1, "", { tools: [], streaming: true });
		let done: Chat.Activity = { id: "t", name: "read_plan", status: "done", took: 4 };
		let running: Chat.Activity = { id: "t", name: "read_plan", status: "running" };
		let state = apply(initialTranscript, [
			{ kind: "message", entry: original },
			{ kind: "tool", entryId: "a", activity: running },
			{ kind: "tool", entryId: "a", activity: done },
			{ kind: "message", entry: original },
			{ kind: "message", entry: { ...original, tools: [running] } },
			{ kind: "tool", entryId: "a", activity: running },
		]);
		expect(state.entries[0]!.tools).toEqual([done]);
	});

	it("puts a tool-only entry's calls in the server's order, whatever order their reports come in", () => {
		let entry = agent("a", 1, 1, "", { tools: [] });
		let call = (
			id: string,
			order: number,
			rev: number,
			status: Chat.ToolStatus,
		): TranscriptAction => ({
			kind: "tool",
			entryId: "a",
			activity: { id, name: "read_plan", status, order, rev },
		});
		let reports = [
			call("t1", 0, 1, "running"),
			call("t1", 0, 2, "done"),
			call("t2", 1, 1, "running"),
			call("t2", 1, 2, "done"),
		];
		let inOrder = apply(initialTranscript, [{ kind: "message", entry }, ...reports]);
		let reversed = apply(initialTranscript, [{ kind: "message", entry }, ...reports.toReversed()]);
		let early = apply(initialTranscript, [...reports.toReversed(), { kind: "message", entry }]);
		for (let state of [inOrder, reversed, early]) {
			expect(state.entries[0]!.tools!.map(tool => [tool.id, tool.status])).toEqual([
				["t1", "done"],
				["t2", "done"],
			]);
		}
	});

	it("keeps a running tool's latest result when an earlier report arrives again", () => {
		let entry = agent("a", 1, 1, "", { tools: [] });
		let report = (rev: number, result: string) => ({
			kind: "tool" as const,
			entryId: "a",
			activity: { id: "t", name: "read_plan", status: "running" as const, order: 0, rev, result },
		});
		let first = report(1, "Read 1 file");
		let state = apply(initialTranscript, [
			{ kind: "message", entry },
			first,
			report(2, "Read 2 files"),
			first,
			{ kind: "message", entry: { ...entry, tools: [first.activity] } },
		]);
		expect(state.entries[0]!.tools!.map(tool => tool.result)).toEqual(["Read 2 files"]);
	});

	it("keeps tool calls when a streaming copy with the same text arrives again", () => {
		let entry = agent("a", 1, 1, "Reading", { streaming: true });
		let done: Chat.Activity = { id: "t", name: "read_plan", status: "done" };
		let state = apply(initialTranscript, [
			{ kind: "message", entry },
			{ kind: "tool", entryId: "a", activity: done },
			{ kind: "message", entry },
		]);
		expect(state.entries[0]!.tools).toEqual([done]);
	});

	it("keeps every entry a Retry took out out, however many it took out", () => {
		let ids = Array.from({ length: 600 }, (_, index) => `gone-${index}`);
		let state = apply(initialTranscript, ids.map(id => ({ kind: "removed", ids: [id] })));
		state = apply(state, [{ kind: "message", entry: agent("gone-0", 1, 1, "Sorry") }]);
		expect(state.entries).toEqual([]);
	});
});
