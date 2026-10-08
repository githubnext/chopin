import { describe, expect, it } from "bun:test";

import { paneMoving } from "./pane-motion";

describe("pane motion", () => {
	it("animates the track while it opens or closes", () => {
		expect(paneMoving("closed", "opening", false)).toBe(true);
		expect(paneMoving("opening", "open", true)).toBe(true);
		expect(paneMoving("open", "closing", false)).toBe(true);
		expect(paneMoving("closing", "open", false)).toBe(true);
	});

	it("follows resizing directly once settled or when motion is immediate", () => {
		expect(paneMoving("closed", "open", false)).toBe(false);
		expect(paneMoving("closing", "closed", true)).toBe(false);
		expect(paneMoving("open", "closed", true)).toBe(false);
	});
});
