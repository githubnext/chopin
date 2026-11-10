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

let broadcast = (reactions: Chat.Reaction[], by: string, seq: number) => ({
	kind: "settle" as const,
	id: "a",
	reactions,
	handle: "ana",
	applied: { by, emoji: "✅", seq },
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

describe("an acknowledgement settles only the request it answers", () => {
	let added = (): readonly Intent[] =>
		intentsReducer(intentsReducer([], { kind: "ask", id: "a", emoji: "✅", on: true }), {
			kind: "sent",
			id: "a",
			emoji: "✅",
			on: true,
		});
	let acknowledgedAdd = {
		kind: "settle" as const,
		id: "a",
		answers: { emoji: "✅", on: true },
		reactions: undefined,
		handle: "ana",
	};

	it("keeps an unsent removal when the add's acknowledgement is read against the older transcript", () => {
		let removed = intentsReducer(added(), { kind: "ask", id: "a", emoji: "✅", on: false });
		let settled = intentsReducer(removed, acknowledgedAdd);
		expect(settled).toEqual([{ id: "a", emoji: "✅", on: false }]);
		expect(dueNow(settled, new Set(["a"]))).toEqual([{ id: "a", emoji: "✅", on: false }]);
	});

	it("keeps a removal already on its way, and asks again for it after a fresh history shows the add", () => {
		let removed = intentsReducer(added(), { kind: "ask", id: "a", emoji: "✅", on: false });
		let going = intentsReducer(removed, { kind: "sent", id: "a", emoji: "✅", on: false });
		let settled = intentsReducer(going, acknowledgedAdd);
		expect(settled).toEqual([{ id: "a", emoji: "✅", on: false, sent: true }]);
		let reconnected = intentsReducer(settled, {
			kind: "history",
			entries: [entry("a", [reaction("✅", "ana")])],
			handle: "ana",
		});
		expect(reconnected).toEqual([{ id: "a", emoji: "✅", on: false }]);
		expect(dueNow(reconnected, new Set(["a"]))).toHaveLength(1);
	});

	it("still retires the intent the acknowledgement answers once the transcript shows it", () => {
		expect(
			intentsReducer(added(), { ...acknowledgedAdd, reactions: [reaction("✅", "ana")] }),
		).toEqual([]);
		expect(intentsReducer(added(), acknowledgedAdd)).toEqual(added());
	});

	it("leaves the other emoji of the message alone", () => {
		let two = intentsReducer(added(), { kind: "ask", id: "a", emoji: "👎", on: false });
		let settled = intentsReducer(two, { ...acknowledgedAdd, reactions: [reaction("✅", "ana")] });
		expect(settled).toEqual([{ id: "a", emoji: "👎", on: false }]);
	});
});

describe("a broadcast settles an intent only if it is not older than the latest ask", () => {
	let ask = (intents: readonly Intent[], on: boolean, seq: number) =>
		intentsReducer(intents, { kind: "ask", id: "a", emoji: "✅", on, seq });
	let sent = (intents: readonly Intent[], on: boolean, seq: number) =>
		intentsReducer(intents, { kind: "sent", id: "a", emoji: "✅", on, seq });
	let sequence = () => ask(sent(ask(sent(ask([], true, 1), true, 1), false, 2), false, 2), true, 3);

	it("keeps the latest ask when the broadcast of an earlier one arrives, and settles it by its own", () => {
		let intents = sequence();
		expect(intents).toEqual([{ id: "a", emoji: "✅", on: true, seq: 3 }]);
		let stale = intentsReducer(intents, broadcast([reaction("✅", "ana")], "ana", 1));
		expect(stale).toEqual(intents);
		expect(dueNow(stale, new Set(["a"]))).toEqual([...intents]);
		let removed = intentsReducer(stale, broadcast([], "ana", 2));
		expect(removed).toEqual(intents);
		expect(intentsReducer(removed, broadcast([reaction("✅", "ana")], "ana", 3))).toEqual([]);
	});

	it("keeps a removal asked after an add whose broadcast arrives first", () => {
		let removed = ask(sent(ask([], true, 1), true, 1), false, 2);
		let intents = intentsReducer(removed, broadcast([reaction("✅", "ana")], "ana", 1));
		expect(intents).toEqual([{ id: "a", emoji: "✅", on: false, seq: 2 }]);
		expect(intentsReducer(intents, broadcast([], "ana", 2))).toEqual([]);
	});

	it("is not settled by what another person did, whatever it shows of this person", () => {
		let intents = sequence();
		expect(intentsReducer(intents, broadcast([reaction("✅", "ana", "ben")], "ben", 9))).toEqual(
			intents,
		);
	});

	it("does not take another emoji's broadcast for this one's", () => {
		let intents = sequence();
		let other = {
			...broadcast([reaction("✅", "ana")], "ana", 9),
			applied: { by: "ana", emoji: "👎", seq: 9 },
		};
		expect(intentsReducer(intents, other)).toEqual(intents);
	});

	it("does not retire a later ask in the same direction on the acknowledgement of an earlier one", () => {
		let again = ask(sent(ask([], true, 1), true, 1), true, 2);
		let settled = intentsReducer(again, {
			kind: "settle",
			id: "a",
			answers: { emoji: "✅", on: true, seq: 1 },
			reactions: [reaction("✅", "ana")],
			handle: "ana",
		});
		expect(settled).toEqual(again);
	});

	it("marks sent, unsent and dropped only the request with the sequence it names", () => {
		let intents = ask(ask([], true, 1), true, 2);
		expect(sent(intents, true, 1)).toEqual(intents);
		let going = sent(intents, true, 2);
		expect(going).toEqual([{ id: "a", emoji: "✅", on: true, seq: 2, sent: true }]);
		expect(intentsReducer(going, { kind: "unsent", id: "a", emoji: "✅", on: true, seq: 1 }))
			.toEqual(
				going,
			);
		expect(intentsReducer(going, { kind: "drop", id: "a", emoji: "✅", on: true, seq: 1 })).toEqual(
			going,
		);
		expect(intentsReducer(going, { kind: "drop", id: "a", emoji: "✅", on: true, seq: 2 })).toEqual(
			[],
		);
	});

	it("keeps the sequence of an ask that is sent again after a fresh history", () => {
		let going = sent(ask([], true, 4), true, 4);
		let reconnected = intentsReducer(going, {
			kind: "history",
			entries: [entry("a")],
			handle: "ana",
		});
		expect(reconnected).toEqual([{ id: "a", emoji: "✅", on: true, seq: 4 }]);
	});
});

let answer = (reactions: Chat.Reaction[] | undefined) => ({
	kind: "settle" as const,
	id: "a",
	answers: { emoji: "✅", on: true, seq: 3 },
	reactions,
	handle: "ana",
	tab: "one",
});

describe("a broadcast settles an ask only for the tab that made it", () => {
	let asked = (): readonly Intent[] =>
		intentsReducer(intentsReducer([], { kind: "ask", id: "a", emoji: "✅", on: true, seq: 3 }), {
			kind: "sent",
			id: "a",
			emoji: "✅",
			on: true,
			seq: 3,
		});
	let answeredAfter = (intents: readonly Intent[], seq: number) =>
		intentsReducer(intents, { kind: "answered", id: "a", emoji: "✅", on: true, seq });
	let heard = (from: string, seq: number) => ({
		kind: "settle" as const,
		id: "a",
		reactions: [reaction("✅", "ana")],
		handle: "ana",
		tab: "one",
		applied: { by: "ana", emoji: "✅", seq, tab: from },
	});
	let heardFromTabWithNoName = (seq: number) => ({
		kind: "settle" as const,
		id: "a",
		reactions: [reaction("✅", "ana")],
		handle: "ana",
		tab: "one",
		applied: { by: "ana", emoji: "✅", seq },
	});
	let listWithNoAsk = {
		kind: "settle" as const,
		id: "a",
		reactions: [reaction("✅", "ana")],
		handle: "ana",
		tab: "one",
	};
	it("is not settled by another tab of the same person, whatever sequence that tab has reached", () => {
		let intents = asked();
		for (let seq of [1, 3, 4, 40]) {
			expect(intentsReducer(intents, heard("two", seq))).toEqual(intents);
		}
		expect(intentsReducer(intents, heard("one", 3))).toEqual([]);
	});

	it("is not settled by a numbered broadcast that names no tab until the server has answered it", () => {
		let intents = asked();
		for (let seq of [1, 3, 4, 40]) {
			expect(intentsReducer(intents, heardFromTabWithNoName(seq))).toEqual(intents);
		}
		let answered = answeredAfter(intentsReducer(intents, answer(undefined)), 3);
		expect(intentsReducer(answered, heardFromTabWithNoName(3))).toEqual([]);
	});

	it("is asked again after a fresh history that shows only the other tab's work undone", () => {
		let kept = intentsReducer(asked(), heard("two", 4));
		let reconnected = intentsReducer(kept, {
			kind: "history",
			entries: [entry("a")],
			handle: "ana",
		});
		expect(reconnected).toEqual([{ id: "a", emoji: "✅", on: true, seq: 3 }]);
		expect(dueNow(reconnected, new Set(["a"]))).toHaveLength(1);
	});

	it("is settled by the server's answer alone when it changed nothing and so told no one", () => {
		let kept = intentsReducer(asked(), heard("two", 4));
		expect(kept).toEqual(asked());
		expect(intentsReducer(kept, answer([reaction("✅", "ana")]))).toEqual([]);
	});

	it("is not settled by a list that names no ask until the server has answered it", () => {
		let intents = asked();
		expect(intentsReducer(intents, listWithNoAsk)).toEqual(intents);
		let kept = intentsReducer(intents, answer(undefined));
		expect(kept).toEqual(intents);
		expect(intentsReducer(answeredAfter(kept, 3), listWithNoAsk)).toEqual([]);
	});

	it("is not taken for answered by the answer of an earlier ask", () => {
		expect(intentsReducer(answeredAfter(asked(), 2), listWithNoAsk)).toEqual(asked());
	});

	it("is not answered any more once it is asked again after a fresh history", () => {
		let reconnected = intentsReducer(answeredAfter(asked(), 3), {
			kind: "history",
			entries: [entry("a")],
			handle: "ana",
		});
		expect(reconnected).toEqual([{ id: "a", emoji: "✅", on: true, seq: 3 }]);
		expect(intentsReducer(reconnected, listWithNoAsk)).toEqual(reconnected);
	});

	it("settles, as before, a list that names no tab for an ask that names no sequence", () => {
		let plain = intentsReducer([], { kind: "ask", id: "a", emoji: "✅", on: true });
		expect(intentsReducer(plain, listWithNoAsk)).toEqual([]);
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
