import { expect, test } from "bun:test";

import {
	ownEmoji,
	QUICK_REACTIONS,
	reactedBy,
	reactionChanges,
	reactionCounts,
	reactionHint,
	withReactions,
} from "./reactions";

import type { Chat } from "@chopin/protocol";

test("the three quick reactions are the exact emoji and the exact words", () => {
	expect(QUICK_REACTIONS.map(item => [item.emoji, item.label])).toEqual([
		["✅", "Looks right"],
		["❓", "Explain this"],
		["👎", "Not quite"],
	]);
	expect(QUICK_REACTIONS[1]!.emoji.codePointAt(0)).toBe(0x2753);
});

test("who reacted: the reader is You, the others are named in the order they reacted", () => {
	let reaction = (...handles: string[]): Chat.Reaction => ({ emoji: "✅", handles });
	expect(reactionHint(reaction("mina"), "ana")).toBe("mina reacted with ✅");
	expect(reactionHint(reaction("ana"), "ana")).toBe("You reacted with ✅");
	expect(reactionHint(reaction("mina", "ana"), "ana")).toBe("mina and You reacted with ✅");
	expect(reactionHint(reaction("mina_acme", "Hubot-Bot", "ana"), "ana")).toBe(
		"mina_acme, Hubot-Bot and You reacted with ✅",
	);
});

test("own reactions are the emoji whose handles hold the reader", () => {
	let reactions: Chat.Reaction[] = [
		{ emoji: "✅", handles: ["mina", "ana"] },
		{ emoji: "👎", handles: ["mina"] },
	];
	expect(reactedBy(reactions[0]!, "ana")).toBe(true);
	expect(reactedBy(reactions[1]!, "ana")).toBe(false);
	expect([...ownEmoji(reactions, "ana")]).toEqual(["✅"]);
	expect(ownEmoji(undefined, "ana").size).toBe(0);
});

test("a message's reactions are replaced, and cleared when the list is empty", () => {
	let entries: Chat.Entry[] = [
		{ id: "a", author: { kind: "agent" }, text: "one", ts: 1 },
		{
			id: "b",
			author: { kind: "agent" },
			text: "two",
			ts: 2,
			reactions: [{ emoji: "✅", handles: ["x"] }],
		},
	];
	let next = withReactions(entries, "a", [{ emoji: "👎", handles: ["y"] }]);
	expect(next[0]!.reactions).toEqual([{ emoji: "👎", handles: ["y"] }]);
	expect(next[1]).toBe(entries[1]!);
	expect(withReactions(next, "b", [])[1]!.reactions).toBeUndefined();
	expect(entries[0]!.reactions).toBeUndefined();
});

test("only a pill that appeared or a count that changed since the message was last drawn moves", () => {
	let first: Chat.Reaction[] = [
		{ emoji: "🎉", handles: ["ana", "ben"] },
		{ emoji: "👀", handles: ["ben"] },
	];
	// Drawn for the first time, history or not, nothing has changed.
	expect(reactionChanges(undefined, first)).toEqual({ entered: new Set(), counted: new Set() });
	let next: Chat.Reaction[] = [
		{ emoji: "🎉", handles: ["ana", "ben", "cy"] },
		{ emoji: "👀", handles: ["ben"] },
		{ emoji: "✅", handles: ["ana"] },
	];
	expect(reactionChanges(reactionCounts(first), next)).toEqual({
		entered: new Set(["✅"]),
		counted: new Set(["🎉"]),
	});
	// The same reactions again move nothing; one taken away is simply gone.
	expect(reactionChanges(reactionCounts(next), next.slice(1))).toEqual({
		entered: new Set(),
		counted: new Set(),
	});
});
