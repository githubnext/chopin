import { expect, test } from "bun:test";

import { newlyDecided } from "./decisions";
import { PendingAnswersStore, summarize, unsavedLabel } from "./save-bar";

import type { PendingAnswers } from "@chopin/question/react";

function pending(change: Partial<PendingAnswers> = {}): PendingAnswers {
	return { answered: 1, complete: true, submitting: false, save() {}, clear() {}, ...change };
}

test("the bar counts answers but saves only complete cards that are not already saving", () => {
	expect(summarize([
		pending(),
		pending({ answered: 1, complete: false }),
		pending({ submitting: true }),
	])).toEqual({ answered: 3, saveable: 1, submitting: true });
	expect(summarize([])).toEqual({ answered: 0, saveable: 0, submitting: false });
});

test("the count reads naturally", () => {
	expect(unsavedLabel(1)).toBe("1 unsaved answer");
	expect(unsavedLabel(2)).toBe("2 unsaved answers");
});

test("the store publishes a new snapshot only when a card changes", () => {
	let store = new PendingAnswersStore();
	let calls = 0;
	store.subscribe(() => calls++);
	let first = store.snapshot();
	store.set("a", undefined);
	expect(calls).toBe(0);
	expect(store.snapshot()).toBe(first);
	store.set("a", pending());
	expect(store.snapshot().size).toBe(1);
	store.set("a", undefined);
	expect(store.snapshot().size).toBe(0);
	expect(calls).toBe(2);
});

test("only a card that left the open list as decided gets a confirmation", () => {
	let status: Record<string, string> = { a: "decided", b: "discarded", c: "open" };
	expect(
		newlyDecided(new Set(["a", "b", "c"]), new Set(["c"]), id => status[id] === "decided"),
	).toEqual(["a"]);
	expect(newlyDecided(new Set(["c"]), new Set(["c"]), () => true)).toEqual([]);
});
