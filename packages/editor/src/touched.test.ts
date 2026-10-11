import { expect, test } from "bun:test";

import { forget, remember, selectionOf, selectionsFor, stillMine, withChange } from "./touched";

import type { Question } from "@chopin/protocol";

const EMPTY: Question.DraftAnswer = {
	mode: "choices",
	choice: null,
	options: { a: false, b: false },
	custom: "",
};

test("a card stays this person's only while the draft holds what they chose", () => {
	let mine = selectionOf(withChange(EMPTY, { mode: "choices", choice: "a" }));
	remember("card", "q", mine);
	let drafts = { q: { ...EMPTY, choice: "a" } };
	expect(stillMine(selectionsFor("card"), drafts)).toBe(true);
	// A collaborator chose something else after them.
	expect(stillMine(selectionsFor("card"), { q: { ...EMPTY, choice: "b" } })).toBe(false);
	// A draft that has not synced yet is not theirs either.
	expect(stillMine(selectionsFor("card"), {})).toBe(false);
	forget("card");
	expect(selectionsFor("card")).toBeUndefined();
	expect(stillMine(undefined, drafts)).toBe(false);
});

test("multiple choices compare as a set, and a choice leaves custom mode", () => {
	let picked = withChange(EMPTY, { mode: "choices", options: { b: true, a: true } });
	expect(selectionOf(picked)).toBe(selectionOf({ ...EMPTY, options: { a: true, b: true } }));
	expect(withChange({ ...EMPTY, mode: "custom", custom: "x" }, { choice: "a" }).mode).toBe(
		"choices",
	);
	expect(selectionOf({ ...EMPTY, mode: "custom", custom: " x " })).toBe("t:x");
});
