import { describe, expect, it } from "bun:test";

import { clampPane, resizeDelta } from "./resizable-pane";

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
});
