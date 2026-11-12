import { expect, test } from "bun:test";

import {
	DEFAULT_FREQUENT,
	frequent,
	noteEmojiUse,
	readTone,
	readUses,
	recordUse,
	writeTone,
} from "./emoji-frequent";
import { moveInGrid } from "./emoji-grid";

function memory(): Pick<Storage, "getItem" | "setItem"> {
	let items = new Map<string, string>();
	return {
		getItem: key => items.get(key) ?? null,
		setItem: (key, value) => void items.set(key, value),
	};
}

test("frequently used starts as Slack's own picks, a row of nine", () => {
	expect(frequent({})).toEqual([...DEFAULT_FREQUENT]);
	expect(DEFAULT_FREQUENT).toHaveLength(9);
	expect(frequent({}, 4)).toEqual(DEFAULT_FREQUENT.slice(0, 4));
});

test("frequently used puts the emoji this person reacts with most first, the latest among equals", () => {
	let uses = recordUse({}, "\u{1F680}", 1);
	uses = recordUse(uses, "\u{1F422}", 2);
	uses = recordUse(uses, "\u{1F680}", 3);
	uses = recordUse(uses, "\u{1F44D}", 4);
	let shown = frequent(uses);
	expect(shown.slice(0, 3)).toEqual(["\u{1F680}", "\u{1F44D}", "\u{1F422}"]);
	// The defaults fill the rest, each once.
	expect(shown).toHaveLength(3 + DEFAULT_FREQUENT.length - 1);
	expect(new Set(shown).size).toBe(shown.length);
	expect(frequent(uses, 2)).toEqual(["\u{1F680}", "\u{1F44D}"]);
});

test("a toned emoji is its own, and the store keeps only the fifty most used", () => {
	let uses = recordUse(recordUse({}, "\u{1F44D}\u{1F3FD}", 1), "\u{1F44D}", 2);
	expect(Object.keys(uses)).toEqual(["\u{1F44D}\u{1F3FD}", "\u{1F44D}"]);
	let many = {};
	for (let i = 0; i < 60; i++) many = recordUse(many, String.fromCodePoint(0x1F600 + i), i);
	expect(Object.keys(many)).toHaveLength(50);
	expect(Object.keys(many)).toContain(String.fromCodePoint(0x1F600 + 59));
});

test("uses and the skin tone are kept in the browser and survive what it cannot read", () => {
	let storage = memory();
	noteEmojiUse("\u{1F389}", storage, 5);
	noteEmojiUse("\u{1F389}", storage, 6);
	expect(readUses(storage)).toEqual({ "\u{1F389}": { count: 2, last: 6 } });
	expect(readTone(storage)).toBe(0);
	writeTone(3, storage);
	expect(readTone(storage)).toBe(3);
	storage.setItem("chopin:emoji-tone", "9");
	expect(readTone(storage)).toBe(0);
	storage.setItem("chopin:emoji-uses", "not json");
	expect(readUses(storage)).toEqual({});
	storage.setItem(
		"chopin:emoji-uses",
		JSON.stringify({ a: { count: "x" }, b: { count: 1, last: 2 } }),
	);
	expect(readUses(storage)).toEqual({ b: { count: 1, last: 2 } });
	expect(readUses(undefined)).toEqual({});
});

test("arrows move through the grid's sections by column, and up from the top row leaves it", () => {
	// Frequently used has 4, the next section 20, the last 3, in rows of nine.
	let sizes = [4, 20, 3];
	expect(moveInGrid(sizes, 0, "ArrowRight", 9)).toBe(1);
	expect(moveInGrid(sizes, 3, "ArrowRight", 9)).toBe(4);
	expect(moveInGrid(sizes, 0, "ArrowLeft", 9)).toBeUndefined();
	expect(moveInGrid(sizes, 0, "ArrowUp", 9)).toBeUndefined();
	// Down from the short first row keeps the column in the next section.
	expect(moveInGrid(sizes, 2, "ArrowDown", 9)).toBe(6);
	expect(moveInGrid(sizes, 6, "ArrowUp", 9)).toBe(2);
	// Up from a column the short row lacks lands on its last emoji.
	expect(moveInGrid(sizes, 4 + 8, "ArrowUp", 9)).toBe(3);
	// Down within a section, then onto a shorter last row, then into the next section.
	expect(moveInGrid(sizes, 4, "ArrowDown", 9)).toBe(13);
	expect(moveInGrid(sizes, 13, "ArrowDown", 9)).toBe(22);
	expect(moveInGrid(sizes, 4 + 17, "ArrowDown", 9)).toBe(23);
	expect(moveInGrid(sizes, 22, "ArrowDown", 9)).toBe(24);
	expect(moveInGrid(sizes, 26, "ArrowDown", 9)).toBe(26);
	expect(moveInGrid(sizes, 10, "Home", 9)).toBe(0);
	expect(moveInGrid(sizes, 10, "End", 9)).toBe(26);
	expect(moveInGrid(sizes, 26, "ArrowRight", 9)).toBe(26);
	expect(moveInGrid([], 0, "ArrowDown", 9)).toBeUndefined();
});
