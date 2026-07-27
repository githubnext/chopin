import { describe, expect, it } from "bun:test";

import { decide, trigger } from "./slash";

/** Defaults to a local, armed, settled keystroke; each case varies one thing. */
function when(over: Partial<Parameters<typeof decide>[0]> = {}) {
	return decide({
		typed: "",
		open: false,
		armed: true,
		remote: false,
		composing: false,
		...over,
	});
}

/** Reads the caret from a `|` marker, so the cases stay legible. */
function at(source: string): string | undefined {
	let offset = source.indexOf("|");
	return trigger(source.replace("|", ""), offset);
}

describe("slash menu trigger", () => {
	it("opens on a slash that starts a block", () => {
		expect(at("/|")).toBe("");
		expect(at("/head|")).toBe("head");
	});

	it("opens on a slash that starts a word", () => {
		expect(at("Rollout /|")).toBe("");
		expect(at("Rollout /table|")).toBe("table");
	});

	it("stays shut inside the paths and URLs a plan is full of", () => {
		expect(at("src/index.ts|")).toBeUndefined();
		expect(at("See https://example.com|")).toBeUndefined();
		expect(at("and/or|")).toBeUndefined();
		expect(at("24/7|")).toBeUndefined();
		expect(at("clients/vm/src|")).toBeUndefined();
	});

	it("closes once the query becomes prose", () => {
		expect(at("/heading one|")).toBeUndefined();
		expect(at("/ |")).toBeUndefined();
	});

	it("ignores slashes the caret has moved away from", () => {
		// Editing earlier in a line that happens to contain a trigger.
		expect(at("Deploy| /table")).toBeUndefined();
		// The caret sits before the slash it would otherwise match.
		expect(at("|/table")).toBeUndefined();
	});

	it("reads the nearest trigger behind the caret", () => {
		expect(at("/first then /second|")).toBe("second");
	});

	it("has nothing to offer without a slash", () => {
		expect(at("Rollout plan|")).toBeUndefined();
		expect(at("|")).toBeUndefined();
	});
});

describe("slash menu gate", () => {
	it("opens for a slash the author typed", () => {
		expect(when()).toBe("open");
		expect(when({ typed: "head" })).toBe("open");
	});

	it("stays shut for a slash that arrived with someone else's edit", () => {
		// An agent turn writing `/workspace/project` recovers the caret into it.
		expect(when({ remote: true })).toBe("ignore");
	});

	it("stays shut when the caret merely moves next to a slash", () => {
		// Clicking after an existing `/` commits an update like any other.
		expect(when({ armed: false })).toBe("ignore");
	});

	it("keeps filtering an open menu whatever caused the update", () => {
		// A peer editing elsewhere must not dismiss the menu being typed into.
		expect(when({ open: true, armed: false })).toBe("open");
		expect(when({ open: true, armed: false, remote: true })).toBe("open");
	});

	it("closes as soon as the trigger is gone, whoever removed it", () => {
		expect(when({ typed: undefined })).toBe("close");
		expect(when({ typed: undefined, open: true })).toBe("close");
		expect(when({ typed: undefined, open: true, remote: true })).toBe("close");
	});

	it("waits out composition rather than acting on half-typed input", () => {
		expect(when({ composing: true })).toBe("ignore");
		// Not even to close: the text mid-composition is not a decision yet.
		expect(when({ composing: true, typed: undefined, open: true })).toBe("ignore");
	});
});
