import { describe, expect, it, spyOn } from "bun:test";
import catalogue from "emojibase-data/en/compact.json";

import { oneEmoji, react, toggle, validateReactions } from "./reactions";
import { create } from "./service";

import type { Server } from "bun";
import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Room } from "./service";
import type { Socket, SocketData } from "../wire";

function harness() {
	let chat = create();
	let published: Array<Record<string, unknown>> = [];
	let saved: Array<Wire.Entry[]> = [];
	let server = {
		publish(_topic: string, data: string) {
			published.push(JSON.parse(data) as Record<string, unknown>);
		},
	} as unknown as Server<SocketData>;
	let context = {
		chat,
		server,
		room: "doc",
		plan: {},
		config: {},
		persist: async (view?: () => { entries: Wire.Entry[] }) => {
			saved.push(structuredClone(view ? view().entries : chat.entries));
		},
	} as unknown as Room;
	chat.entries.push(
		{ id: "m1", author: { kind: "member", handle: "ana" }, text: "Plan it.", ts: 1 },
		{ id: "a1", author: { kind: "agent" }, text: "Done.", ts: 2 },
		{ id: "s1", author: { kind: "system" }, text: "ana asked Chopin to draft.", ts: 3 },
	);
	return { chat, context, published, saved };
}

function socket(handle: string) {
	let sent: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle },
		send(frame: string) {
			sent.push(JSON.parse(frame) as Record<string, unknown>);
		},
	} as unknown as Socket;
	return { ws, sent };
}

function ask(
	id: string,
	emoji: string,
	on: boolean,
	rid: string = crypto.randomUUID(),
	seq?: number,
) {
	return {
		kind: "chat:react",
		rid,
		ts: 0,
		id,
		emoji,
		on,
		...(seq === undefined ? {} : { seq }),
	} as Request<Wire.React>;
}

/** Every emoji the picker offers, each skin tone and sequence among them: what its Add reaction sends. */
let offered = (catalogue as Array<{ unicode: string; skins?: Array<{ unicode: string }> }>)
	.flatMap(item => [item.unicode, ...(item.skins ?? []).map(skin => skin.unicode)]);

describe("toggling a reaction", () => {
	it("keeps emoji in the order first used and handles in the order they reacted", () => {
		let one = toggle(undefined, "ana", "✅", true).reactions;
		let two = toggle(one, "ben", "👀", true).reactions;
		let three = toggle(two, "cy", "✅", true).reactions;
		expect(three).toEqual([
			{ emoji: "✅", handles: ["ana", "cy"] },
			{ emoji: "👀", handles: ["ben"] },
		]);
	});

	it("takes back one person's reaction and drops an emoji nobody uses", () => {
		let start = [{ emoji: "✅", handles: ["ana", "ben"] }, { emoji: "👀", handles: ["ana"] }];
		let one = toggle(start, "ana", "✅", false);
		expect(one).toEqual({
			changed: true,
			reactions: [{ emoji: "✅", handles: ["ben"] }, { emoji: "👀", handles: ["ana"] }],
		});
		expect(toggle(one.reactions, "ana", "👀", false).reactions).toEqual([
			{ emoji: "✅", handles: ["ben"] },
		]);
	});

	it("changes nothing when asked for what is already so", () => {
		let start = [{ emoji: "✅", handles: ["ana"] }];
		expect(toggle(start, "ana", "✅", true)).toEqual({ changed: false, reactions: start });
		expect(toggle(start, "ben", "✅", false).changed).toBe(false);
		expect(toggle(undefined, "ben", "🙌", false)).toEqual({ changed: false, reactions: [] });
	});

	it("keeps any emoji exactly as sent, joiners, skin tones, flags and keycaps included", () => {
		let sequences = ["👨‍👩‍👧‍👦", "👍🏽", "🇳🇴", "1️⃣", "❤", "❤️", "x"];
		let reactions = sequences.reduce<Wire.Reaction[]>(
			(all, emoji) => toggle(all, "ana", emoji, true).reactions,
			[],
		);
		expect(reactions.map(reaction => reaction.emoji)).toEqual(sequences);
	});
});

describe("reacting to a message", () => {
	it("saves the reaction before anyone is told, then answers the sender and tells the room", async () => {
		let { context, chat, published, saved } = harness();
		let release!: () => void;
		let gate = new Promise<void>(resolve => release = resolve);
		let persist = context.persist;
		context.persist = async view => {
			await gate;
			return persist(view);
		};
		let { ws, sent } = socket("ana");
		let pending = react(context, ws, ask("a1", "✅", true, "r1"));
		await Bun.sleep(5);
		expect(published).toEqual([]);
		expect(sent).toEqual([]);
		expect(chat.entries[1]!.reactions).toBeUndefined();
		release();
		await pending;
		expect(saved[0]![1]!.reactions).toEqual([{ emoji: "✅", handles: ["ana"] }]);
		expect(sent).toMatchObject([{
			kind: "chat:react",
			id: "a1",
			emoji: "✅",
			on: true,
			rid: "r1",
		}]);
		expect(published).toMatchObject([{
			kind: "chat:reactions",
			id: "a1",
			reactions: [{ emoji: "✅", handles: ["ana"] }],
		}]);
		expect(chat.entries[1]!.reactions).toEqual([{ emoji: "✅", handles: ["ana"] }]);
	});

	it("lets every person react to any person's or the Planner's message, and take it back", async () => {
		let { context, chat, published } = harness();
		let ana = socket("ana");
		let ben = socket("ben");
		await react(context, ana.ws, ask("m1", "🙌", true));
		await react(context, ben.ws, ask("m1", "🙌", true));
		await react(context, ben.ws, ask("a1", "❓", true));
		expect(chat.entries[0]!.reactions).toEqual([{ emoji: "🙌", handles: ["ana", "ben"] }]);
		expect(chat.entries[1]!.reactions).toEqual([{ emoji: "❓", handles: ["ben"] }]);
		await react(context, ana.ws, ask("m1", "🙌", false));
		await react(context, ben.ws, ask("m1", "🙌", false));
		expect(chat.entries[0]!.reactions).toBeUndefined();
		expect(published.at(-1)).toMatchObject({ kind: "chat:reactions", id: "m1", reactions: [] });
	});

	it("answers a repeated request without saving or telling anyone again", async () => {
		let { context, published, saved } = harness();
		let { ws, sent } = socket("ana");
		await react(context, ws, ask("a1", "✅", true));
		await react(context, ws, ask("a1", "✅", true, "again"));
		expect(saved).toHaveLength(1);
		expect(published).toHaveLength(1);
		expect(sent.at(-1)).toMatchObject({ kind: "chat:react", on: true, rid: "again" });
	});

	it("names the ask in its answer and in the broadcast, so an earlier ask's is told from a later one's", async () => {
		let { context, published } = harness();
		let { ws, sent } = socket("ana");
		await react(context, ws, ask("a1", "✅", true, "r1", 1));
		await react(context, ws, ask("a1", "✅", false, "r2", 2));
		await react(context, ws, ask("a1", "✅", true, "r3", 3));
		expect(sent).toMatchObject([
			{ rid: "r1", on: true, seq: 1 },
			{ rid: "r2", on: false, seq: 2 },
			{ rid: "r3", on: true, seq: 3 },
		]);
		expect(published).toMatchObject([
			{ id: "a1", by: "ana", emoji: "✅", seq: 1, reactions: [{ emoji: "✅", handles: ["ana"] }] },
			{ id: "a1", by: "ana", emoji: "✅", seq: 2, reactions: [] },
			{ id: "a1", by: "ana", emoji: "✅", seq: 3, reactions: [{ emoji: "✅", handles: ["ana"] }] },
		]);
	});

	it("answers a repeated ask with its own sequence, and an ask with none without one", async () => {
		let { context, published } = harness();
		let { ws, sent } = socket("ana");
		await react(context, ws, ask("a1", "✅", true, "r1", 4));
		await react(context, ws, ask("a1", "✅", true, "r2", 5));
		expect(sent.at(-1)).toMatchObject({ rid: "r2", seq: 5 });
		expect(published).toHaveLength(1);
		await react(context, ws, ask("a1", "👎", true, "r3"));
		expect(sent.at(-1)).not.toHaveProperty("seq");
		let last = published.at(-1)!;
		expect(last).not.toHaveProperty("seq");
		expect(last).not.toHaveProperty("by");
		expect(last).not.toHaveProperty("emoji");
	});

	it("names the tab that made a numbered ask in the broadcast, so another tab of the person is told from it", async () => {
		let { context, published } = harness();
		let { ws } = socket("ana");
		let other = socket("ana");
		await react(context, ws, { ...ask("a1", "✅", true, "r1", 1), tab: "one" } as never);
		await react(context, other.ws, { ...ask("a1", "✅", false, "r2", 1), tab: "two" } as never);
		expect(published).toMatchObject([
			{ id: "a1", by: "ana", emoji: "✅", seq: 1, tab: "one" },
			{ id: "a1", by: "ana", emoji: "✅", seq: 1, tab: "two" },
		]);
	});

	it("takes an ask for what it says without a tab, or with one that is not a name, and refuses none of them", async () => {
		let { context, published } = harness();
		let { ws, sent } = socket("ana");
		let tabs: unknown[] = [undefined, 1, null, {}, ["one"], true];
		for (let [index, tab] of tabs.entries()) {
			await react(context, ws, {
				...ask("a1", "✅", index % 2 === 0, `r${index}`, index),
				...(tab === undefined ? {} : { tab }),
			} as never);
		}
		expect(sent.map(frame => frame.kind)).toEqual(Array(tabs.length).fill("chat:react"));
		expect(published).toHaveLength(tabs.length);
		for (let frame of published) {
			expect(frame).toMatchObject({ by: "ana", emoji: "✅" });
			expect(frame).not.toHaveProperty("tab");
		}
	});

	it("names no tab in the broadcast of an ask that names no sequence", async () => {
		let { context, published } = harness();
		let { ws } = socket("ana");
		await react(context, ws, { ...ask("a1", "✅", true), tab: "one" } as never);
		let last = published.at(-1)!;
		expect(last).not.toHaveProperty("tab");
		expect(last).not.toHaveProperty("by");
	});

	it("refuses a sequence that is not a whole number", async () => {
		let { context, saved, published } = harness();
		let { ws, sent } = socket("ana");
		for (let seq of ["1", -1, 1.5, Number.NaN, null]) {
			await react(context, ws, { ...ask("a1", "✅", true), seq } as never);
		}
		expect(sent.map(frame => frame.kind)).toEqual(Array(5).fill("session:error"));
		expect(saved).toEqual([]);
		expect(published).toEqual([]);
	});

	it("refuses a system notice, a message that is not there and a request that is not one", async () => {
		let { context, saved, published } = harness();
		let { ws, sent } = socket("ana");
		await react(context, ws, ask("s1", "✅", true));
		await react(context, ws, ask("missing", "✅", true));
		await react(context, ws, ask("a1", "", true));
		await react(context, ws, { ...ask("a1", "✅", true), on: "yes" } as never);
		expect(sent.map(frame => frame.kind)).toEqual(Array(4).fill("session:error"));
		expect(saved).toEqual([]);
		expect(published).toEqual([]);
	});

	it("takes as many different emoji on one message as people give it, each of them within their own limit", async () => {
		let { context, chat, saved, published } = harness();
		let people = Array.from({ length: 15 }, (_, index) => socket(`person${index}`));
		for (let [index, person] of people.entries()) {
			for (let emoji of offered.slice(index * 20, index * 20 + 20)) {
				await react(context, person.ws, ask("a1", emoji, true));
			}
		}
		expect(chat.entries[1]!.reactions).toHaveLength(300);
		expect(saved).toHaveLength(300);
		expect(published).toHaveLength(300);
		for (let person of people) {
			expect(person.sent.every(frame => frame.kind === "chat:react")).toBe(true);
		}
		// Saved so, a message like that is read back whole.
		validateReactions(chat.entries[1]!);
	});

	it("keeps the unsaved reaction out of the room and tells the sender it may be asked again", async () => {
		let errors = spyOn(console, "error").mockImplementation(() => {});
		let { context, chat, published } = harness();
		context.persist = async () => {
			throw new Error("storage busy");
		};
		let { ws, sent } = socket("ana");
		await react(context, ws, ask("a1", "✅", true));
		expect(sent).toMatchObject([{
			kind: "session:error",
			code: "temporarily-unavailable",
		}]);
		expect(chat.entries[1]!.reactions).toBeUndefined();
		expect(published).toEqual([]);
		errors.mockRestore();
	});

	it("takes reactions in order behind a message still being accepted", async () => {
		let { context, chat } = harness();
		let order: string[] = [];
		let release!: () => void;
		chat.sending = new Promise<void>(resolve => release = resolve).then(() => {
			order.push("send");
		});
		let { ws } = socket("ana");
		let pending = react(context, ws, ask("a1", "✅", true), () => order.push("reaction"));
		await Bun.sleep(5);
		expect(order).toEqual([]);
		release();
		await pending;
		expect(order).toEqual(["send", "reaction"]);
	});

	it("tells what changed only once it is saved", async () => {
		let { context } = harness();
		let seen: Array<[string, string, boolean]> = [];
		let { ws } = socket("ana");
		await react(
			context,
			ws,
			ask("a1", "❓", true),
			({ entry, handle, on }) => seen.push([entry.id, handle, on]),
		);
		expect(seen).toEqual([["a1", "ana", true]]);
	});
});

let refusals = (sent: Array<Record<string, unknown>>) =>
	sent.filter(frame => frame.kind === "session:error");

describe("the bounds of a reaction", () => {
	/** One combining mark is two bytes, and joins the letter or emoji before it. */
	let MARK = "\u0301";
	async function refused(emoji: string) {
		let { context, chat, saved, published } = harness();
		let { ws, sent } = socket("ana");
		let told: unknown[] = [];
		await react(context, ws, ask("a1", emoji, true), reacted => told.push(reacted));
		return { sent, saved, published, told, entry: chat.entries[1]! };
	}

	it("refuses a string of more than one grapheme cluster, whatever each of them is", async () => {
		for (let emoji of ["🙂🙃", "👍👍", "ab", "👍 ", "🇳🇴🇳🇴", "👨‍👩‍👧‍👦👨‍👩‍👧‍👦", "x".repeat(5_000)]) {
			let result = await refused(emoji);
			expect(result.sent, emoji.slice(0, 8)).toMatchObject([{
				kind: "session:error",
				message: "a reaction is a single emoji",
			}]);
			// A refusal for a reason that will not pass is never marked as passing.
			expect(result.sent[0]).not.toHaveProperty("code");
			expect(result.saved, emoji.slice(0, 8)).toEqual([]);
			expect(result.published, emoji.slice(0, 8)).toEqual([]);
			expect(result.told, emoji.slice(0, 8)).toEqual([]);
			expect(result.entry.reactions, emoji.slice(0, 8)).toBeUndefined();
		}
	});

	it("takes a single grapheme cluster of up to 64 bytes and refuses one of 65, though both are one cluster", async () => {
		let { context, chat, published } = harness();
		let { ws, sent } = socket("ana");
		let longest = "👍" + MARK.repeat(30);
		let tooLong = "x" + MARK.repeat(32);
		expect(new TextEncoder().encode(longest)).toHaveLength(64);
		expect(new TextEncoder().encode(tooLong)).toHaveLength(65);
		expect([...new Intl.Segmenter().segment(longest)]).toHaveLength(1);
		expect([...new Intl.Segmenter().segment(tooLong)]).toHaveLength(1);
		await react(context, ws, ask("a1", longest, true));
		await react(context, ws, ask("a1", tooLong, true));
		expect(sent).toMatchObject([
			{ kind: "chat:react", emoji: longest },
			{ kind: "session:error", message: "a reaction is a single emoji" },
		]);
		expect(chat.entries[1]!.reactions).toEqual([{ emoji: longest, handles: ["ana"] }]);
		expect(published).toHaveLength(1);
	});

	it("takes every emoji the picker offers, so the picker and the server cannot drift apart", () => {
		expect(offered.length).toBeGreaterThan(3_900);
		expect(offered).toContain("🧑🏻‍❤️‍💋‍🧑🏼");
		expect(offered.filter(emoji => !oneEmoji(emoji))).toEqual([]);
	});

	it("refuses a person's 21st different reaction to a message, and keeps and tells nothing of it", async () => {
		let { context, chat, saved, published } = harness();
		let ana = socket("ana");
		let told: unknown[] = [];
		for (let emoji of offered.slice(0, 20)) {
			await react(context, ana.ws, ask("a1", emoji, true));
		}
		let savedBefore = saved.length;
		let publishedBefore = published.length;
		await react(context, ana.ws, ask("a1", offered[20]!, true), reacted => told.push(reacted));
		expect(ana.sent.slice(0, 20).every(frame => frame.kind === "chat:react")).toBe(true);
		expect(ana.sent.at(-1)).toMatchObject({
			kind: "session:error",
			message: "you can react to a message with at most 20 different emoji",
		});
		expect(ana.sent.at(-1)).not.toHaveProperty("code");
		expect(saved).toHaveLength(savedBefore);
		expect(published).toHaveLength(publishedBefore);
		expect(told).toEqual([]);
		expect(chat.entries[1]!.reactions!.map(reaction => reaction.emoji)).toEqual(
			offered.slice(0, 20),
		);
	});

	it("counts a person's reactions to one message, not those of other people or to other messages", async () => {
		let { context, chat } = harness();
		let ana = socket("ana");
		let ben = socket("ben");
		for (let emoji of offered.slice(0, 20)) await react(context, ana.ws, ask("a1", emoji, true));
		// Ben has none of his own on that message, though the message has twenty emoji; he may
		// join in on one of theirs and add one of his own, and Ana may react to another message.
		await react(context, ben.ws, ask("a1", offered[0]!, true));
		await react(context, ben.ws, ask("a1", offered[20]!, true));
		await react(context, ana.ws, ask("m1", offered[20]!, true));
		expect(refusals(ana.sent)).toEqual([]);
		expect(refusals(ben.sent)).toEqual([]);
		expect(chat.entries[1]!.reactions).toHaveLength(21);
		expect(chat.entries[0]!.reactions).toEqual([{ emoji: offered[20]!, handles: ["ana"] }]);
	});

	it("keeps allowing a reaction taken back and added again at the limit, and gives the place back to another", async () => {
		let { context, chat, published } = harness();
		let ana = socket("ana");
		let first = offered.slice(0, 20);
		for (let emoji of first) await react(context, ana.ws, ask("a1", emoji, true));
		// Asking again for one already held at the limit is answered as before, not refused.
		await react(context, ana.ws, ask("a1", first[3]!, true, "again"));
		expect(ana.sent.at(-1)).toMatchObject({ kind: "chat:react", rid: "again", on: true });
		await react(context, ana.ws, ask("a1", first[3]!, false));
		expect(chat.entries[1]!.reactions).toHaveLength(19);
		await react(context, ana.ws, ask("a1", first[3]!, true));
		expect(chat.entries[1]!.reactions!.flatMap(reaction => reaction.handles)).toHaveLength(20);
		expect(refusals(ana.sent)).toEqual([]);
		// A place she gave up is one she may fill with another, and then she is at the limit again.
		await react(context, ana.ws, ask("a1", first[3]!, false));
		await react(context, ana.ws, ask("a1", offered[20]!, true));
		expect(refusals(ana.sent)).toEqual([]);
		await react(context, ana.ws, ask("a1", first[3]!, true));
		expect(refusals(ana.sent)).toMatchObject([{ message: expect.stringContaining("at most 20") }]);
		expect(published.at(-1)).toMatchObject({
			reactions: expect.arrayContaining([{ emoji: offered[20]!, handles: ["ana"] }]),
		});
	});
});

describe("restoring saved reactions", () => {
	let entry = (reactions: unknown): Wire.Entry =>
		({ id: "a1", author: { kind: "agent" }, text: "x", ts: 1, reactions }) as Wire.Entry;

	it("accepts what was saved and an entry with none", () => {
		validateReactions(entry([{ emoji: "✅", handles: ["ana", "ben"] }]));
		validateReactions({ id: "a1", author: { kind: "agent" }, text: "x", ts: 1 });
	});

	it("refuses a list that could not have been saved", () => {
		for (
			let bad of [
				"✅",
				[],
				[{ emoji: "✅", handles: [] }],
				[{ emoji: "", handles: ["ana"] }],
				[{ emoji: "✅", handles: ["ana", "ana"] }],
				[{ emoji: "✅", handles: ["ana"] }, { emoji: "✅", handles: ["ben"] }],
				[{ emoji: "✅", handles: ["ana"], extra: 1 }],
				[null],
			]
		) {
			expect(() => validateReactions(entry(bad))).toThrow("invalid chat reactions");
		}
		expect(() =>
			validateReactions({
				id: "s",
				author: { kind: "system" },
				text: "x",
				ts: 1,
				reactions: [{ emoji: "✅", handles: ["ana"] }],
			})
		).toThrow("invalid chat reactions");
	});
});
