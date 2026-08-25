import { describe, expect, it } from "bun:test";

import {
	clampPane,
	keyboardPaneDelta,
	readPaneWidth,
	resizeDelta,
	restorePaneWidth,
	writePaneWidth,
} from "./resizable-pane";

describe("bounded pane resizing", () => {
	it("keeps a pane width within its inclusive bounds", () => {
		expect(clampPane(249, 250, 400)).toBe(250);
		expect(clampPane(304, 304, 400)).toBe(304);
		expect(clampPane(401, 250, 400)).toBe(400);
	});

	it("moves each pane edge in its screen direction", () => {
		expect(resizeDelta("left", 16)).toBe(16);
		expect(resizeDelta("right", 16)).toBe(-16);
	});

	it("restores a valid saved width and rejects invalid persisted values", () => {
		let bounds = { initial: 304, min: 304, max: 400 };

		expect(restorePaneWidth("360", bounds)).toBe(360);
		expect(restorePaneWidth("800", bounds)).toBe(400);
		expect(restorePaneWidth("bad", bounds)).toBe(304);
		expect(restorePaneWidth(null, bounds)).toBe(304);
	});

	it("does not read or write shared storage for an isolated pane", () => {
		let reads: string[] = [];
		let writes: Array<[string, string]> = [];
		let storage = {
			getItem(key: string) {
				reads.push(key);
				return "360";
			},
			setItem(key: string, value: string) {
				writes.push([key, value]);
			},
		};
		let bounds = { initial: 304, min: 304, max: 400 };

		expect(readPaneWidth(storage, undefined, bounds)).toBe(304);
		writePaneWidth(storage, undefined, 320);
		expect(reads).toEqual([]);
		expect(writes).toEqual([]);

		expect(readPaneWidth(storage, "chopin:pane:chat", bounds)).toBe(360);
		writePaneWidth(storage, "chopin:pane:chat", 320);
		expect(reads).toEqual(["chopin:pane:chat"]);
		expect(writes).toEqual([["chopin:pane:chat", "320"]]);
	});

	it("maps keyboard commands to bounded pane movements", () => {
		let bounds = { min: 304, max: 400 };

		expect(keyboardPaneDelta("left", "ArrowRight", false, 320, bounds)).toBe(16);
		expect(keyboardPaneDelta("right", "ArrowRight", true, 384, bounds)).toBe(-64);
		expect(keyboardPaneDelta("left", "Home", false, 360, bounds)).toBe(-56);
		expect(keyboardPaneDelta("right", "End", false, 360, bounds)).toBe(40);
		expect(keyboardPaneDelta("left", "Tab", false, 360, bounds)).toBeUndefined();
	});
});
