import { afterEach, describe, expect, it } from "bun:test";

import {
	claimDecision,
	currentDecision,
	decisionReplyCurrent,
	releaseDecision,
	subscribeDecision,
} from "./decision-pin";

afterEach(() => releaseDecision());

describe("one decided popover across mounted editors", () => {
	it("replaces another editor's pin without lending it to the previous editor", () => {
		let parent = {};
		let child = {};
		let seen: Array<string | undefined> = [];
		let off = subscribeDecision(() => seen.push(currentDecision()?.id));

		claimDecision(parent, "first");
		claimDecision(child, "second");
		releaseDecision(parent);
		expect(currentDecision()).toEqual({ owner: child, id: "second" });
		expect(seen).toEqual(["first", "second"]);

		releaseDecision(child);
		expect(currentDecision()).toBeUndefined();
		off();
	});
});

it("only presents an action reply for the intent that started it", () => {
	let original = {};
	let other = {};
	claimDecision(original, "a");
	expect(decisionReplyCurrent(original, "a", 2, 2)).toBe(true);
	releaseDecision(original); // The authoritative meta can remove A before its reply arrives.
	expect(decisionReplyCurrent(original, "a", 2, 2)).toBe(true);
	claimDecision(other, "b");
	expect(decisionReplyCurrent(original, "a", 2, 2)).toBe(false);
	releaseDecision(other);
	claimDecision(original, "b");
	expect(decisionReplyCurrent(original, "a", 2, 2)).toBe(false);
	releaseDecision(original);
	expect(decisionReplyCurrent(original, "a", 2, 3)).toBe(false);
});

it("keeps a newer pin when an older discard finishes in the same editor", () => {
	let owner = {};
	claimDecision(owner, "pending-a");
	claimDecision(owner, "new-b");
	releaseDecision(owner, "pending-a");
	expect(currentDecision()).toEqual({ owner, id: "new-b" });
});
