import { describe, expect, it } from "bun:test";

import { dueNow, type Intent, intentsReducer, withIntents } from "./pending-reactions";

import type { Chat } from "@chopin/protocol";

let reaction = (emoji: string, ...handles: string[]): Chat.Reaction => ({ emoji, handles });
let entry = (id: string, reactions?: Chat.Reaction[]): Chat.Entry => ({
	id,
	author: { kind: "agent" },
	text: id,
	ts: 1,
	reactions,
});

describe("asking for a reaction", () => {
	it("keeps one intent per message and emoji, the latest ask winning and going out again", () => {
		let first = intentsReducer([], { kind: "ask", id: "a", emoji: "✅", on: true });
		let sent = intentsReducer(first, { kind: "sent", id: "a", emoji: "✅", on: true });
		expect(sent).toEqual([{ id: "a", emoji: "✅", on: true, sent: true }]);
		let again = intentsReducer(sent, { kind: "ask", id: "a", emoji: "✅", on: false });
		expect(again).toEqual([{ id: "a", emoji: "✅", on: false }]);
		expect(intentsReducer(again, { kind: "ask", id: "a", emoji: "👎", on: true })).toHaveLength(2);
	});

	it("marks sent only the ask that went out, not one that replaced it meanwhile", () => {
		let intents = intentsReducer([], { kind: "ask", id: "a", emoji: "✅", on: false });
		expect(intentsReducer(intents, { kind: "sent", id: "a", emoji: "✅", on: true })).toEqual(
			intents,
		);
	});

	it("goes out only for a message the server has, and only once", () => {
		let intents: Intent[] = [
			{ id: "saved", emoji: "✅", on: true },
			{ id: "queued", emoji: "✅", on: true },
			{ id: "saved", emoji: "👎", on: true, sent: true },
		];
		expect(dueNow(intents, new Set(["saved"]))).toEqual([{ id: "saved", emoji: "✅", on: true }]);
		expect(dueNow(intents, new Set(["saved", "queued"]))).toHaveLength(2);
	});

	it("goes out again after a lost connection, and is dropped after a refusal", () => {
		let sent = intentsReducer([], { kind: "ask", id: "a", emoji: "✅", on: true });
		sent = intentsReducer(sent, { kind: "sent", id: "a", emoji: "✅", on: true });
		let unsent = intentsReducer(sent, { kind: "unsent", id: "a", emoji: "✅", on: true });
		expect(dueNow(unsent, new Set(["a"]))).toHaveLength(1);
		expect(intentsReducer(sent, { kind: "drop", id: "a", emoji: "✅", on: true })).toEqual([]);
	});
});

describe("the server's word settles an intent", () => {
	let asked = intentsReducer(
		intentsReducer([], { kind: "ask", id: "a", emoji: "✅", on: true }),
		{ kind: "ask", id: "a", emoji: "❓", on: false },
	);

	it("removes an intent the message's reactions already satisfy and keeps the rest", () => {
		let settled = intentsReducer(asked, {
			kind: "settle",
			id: "a",
			reactions: [reaction("✅", "mina", "ana")],
			handle: "ana",
		});
		expect(settled).toEqual([]);
	});

	it("keeps an ask the reactions do not yet show, for the message it is about only", () => {
		let kept = intentsReducer(asked, {
			kind: "settle",
			id: "a",
			reactions: [reaction("✅", "mina")],
			handle: "ana",
		});
		expect(kept).toEqual([{ id: "a", emoji: "✅", on: true }]);
		expect(intentsReducer(kept, { kind: "settle", id: "b", reactions: [], handle: "ana" })).toBe(
			kept,
		);
	});

	it("on a fresh history, sends every kept ask again and settles those already so", () => {
		let sent = asked.map(intent => ({ ...intent, sent: true as const }));
		let next = intentsReducer(sent, {
			kind: "history",
			entries: [entry("a", [reaction("✅", "ana")])],
			handle: "ana",
		});
		expect(next).toEqual([]);
		let still = intentsReducer(sent, { kind: "history", entries: [entry("a")], handle: "ana" });
		expect(still).toEqual([{ id: "a", emoji: "✅", on: true }]);
		let unseen = intentsReducer(sent, {
			kind: "history",
			entries: [entry("other")],
			handle: "ana",
		});
		expect(unseen.map(intent => intent.sent)).toEqual([undefined, undefined]);
	});

	it("forgets an ask for a message that is nowhere any more", () => {
		expect(intentsReducer(asked, { kind: "prune", present: new Set(["a"]) })).toEqual(asked);
		expect(intentsReducer(asked, { kind: "prune", present: new Set(["b"]) })).toEqual([]);
	});
});

describe("a message with unconfirmed reactions", () => {
	it("shows your ask on top of what the server says, and which emoji are still waiting", () => {
		let shown = withIntents(
			[reaction("✅", "mina"), reaction("👎", "ana")],
			[
				{ id: "a", emoji: "✅", on: true },
				{ id: "a", emoji: "👎", on: false },
				{ id: "a", emoji: "🎉", on: true },
				{ id: "other", emoji: "🎉", on: true },
			],
			"a",
			"ana",
		);
		expect(shown.reactions).toEqual([reaction("✅", "mina", "ana"), reaction("🎉", "ana")]);
		expect([...shown.pending]).toEqual(["✅", "👎", "🎉"]);
	});

	it("is the server's own list when nothing is waiting, or the ask is already so", () => {
		let held = [reaction("✅", "ana")];
		let shown = withIntents(held, [{ id: "a", emoji: "✅", on: true }], "a", "ana");
		expect(shown.reactions).toEqual(held);
		expect(shown.pending.size).toBe(0);
		expect(withIntents(undefined, [], "a", "ana")).toEqual({ reactions: [], pending: new Set() });
	});
});
