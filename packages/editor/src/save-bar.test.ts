import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { decidedBy, newlyDecided } from "./decisions";
import {
	failedLabel,
	incompleteLabel,
	newlyFailed,
	PendingAnswersStore,
	SaveBar,
	summarize,
	unsavedLabel,
} from "./save-bar";

import type { PendingAnswers } from "@chopin/question/react";

function pending(change: Partial<PendingAnswers> = {}): PendingAnswers {
	return { answered: 1, complete: true, submitting: false, save() {}, clear() {}, ...change };
}

test("the bar saves only complete cards that are not already saving", () => {
	expect(summarize([
		["a", pending()],
		["b", pending({ complete: false })],
		["c", pending({ submitting: true })],
	])).toEqual({
		answered: 3,
		saveable: 1,
		submitting: true,
		failed: [],
		failedAnswers: 0,
		incomplete: ["b"],
	});
});

test("a failed card is reported once it stops saving", () => {
	let cards = new Map([
		["a", pending({ answered: 2, error: "Could not submit these answers." })],
		["b", pending({ submitting: true, error: "stale" })],
	]);
	let summary = summarize(cards);
	expect(summary.failed).toEqual(["a"]);
	expect(summary.failedAnswers).toBe(2);
	expect(newlyFailed(new Set(), cards)).toEqual(["a"]);
	expect(newlyFailed(new Set(["a"]), cards)).toEqual([]);
});

function barMarkup(cards: PendingAnswers[]) {
	let store = new PendingAnswersStore();
	for (let [index, card] of cards.entries()) store.set(String(index), card);
	return renderToStaticMarkup(createElement(SaveBar, {
		store,
		onFailed() {},
		onIncomplete() {},
	}));
}

test("the phone uses Save for individual answers and batches", () => {
	expect(barMarkup([pending()])).toContain(">Save<");
	expect(barMarkup([pending(), pending()])).toContain(">Save<");
	expect(barMarkup([pending({ complete: false }), pending()])).toContain(">Save<");
});

test("the save bar shows retry, progress and incomplete states", () => {
	expect(barMarkup([pending({ error: "Review the shared answer." })])).toContain(">Try again<");
	expect(barMarkup([pending({ submitting: true })])).toContain(">Saving…<");
	expect(barMarkup([pending({ complete: false })])).toContain(">Show<");
});

test("the bar's words read naturally", () => {
	expect(unsavedLabel(1)).toBe("1 unsaved answer");
	expect(unsavedLabel(2)).toBe("2 unsaved answers");
	expect(failedLabel(1)).toBe("Couldn’t save 1 answer");
	expect(incompleteLabel(1)).toBe("1 decision needs another answer");
	expect(incompleteLabel(2)).toBe("2 decisions need more answers");
});

test("the store publishes a new snapshot only when a card changes, and remembers local saves", () => {
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
	expect(store.savedHere("a")).toBe(false);
	store.submitted("a");
	expect(store.savedHere("a")).toBe(true);
});

test("only a card that left the open list as decided folds away", () => {
	let status: Record<string, string> = { a: "decided", b: "discarded", c: "open" };
	expect(
		newlyDecided(new Set(["a", "b", "c"]), new Set(["c"]), id => status[id] === "decided"),
	).toEqual(["a"]);
	expect(newlyDecided(new Set(["c"]), new Set(["c"]), () => true)).toEqual([]);
});

test("the confirmation names who decided", () => {
	expect(decidedBy("ana", "ana")).toBe("You");
	expect(decidedBy("ben", "ana")).toBe("@ben");
	expect(decidedBy(undefined, "ana")).toBeUndefined();
	expect(decidedBy("system", "ana")).toBeUndefined();
});
