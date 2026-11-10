import { describe, expect, it, spyOn } from "bun:test";

import { react, toggle, validateReactions } from "./reactions";
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

function ask(id: string, emoji: string, on: boolean, rid: string = crypto.randomUUID()) {
	return { kind: "chat:react", rid, ts: 0, id, emoji, on } as Request<Wire.React>;
}

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

	it("accepts an emoji of any form or length and any number of emoji on one message", async () => {
		let { context, chat, saved, published } = harness();
		let { ws, sent } = socket("ana");
		let long = "x".repeat(5_000);
		await react(context, ws, ask("a1", long, true));
		expect(chat.entries[1]!.reactions).toEqual([{ emoji: long, handles: ["ana"] }]);
		for (let index = 0; index < 300; index++) {
			await react(context, ws, ask("a1", `e${index}`, true));
		}
		expect(chat.entries[1]!.reactions).toHaveLength(301);
		expect(sent.every(frame => frame.kind === "chat:react")).toBe(true);
		expect(saved).toHaveLength(301);
		expect(published).toHaveLength(301);
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
