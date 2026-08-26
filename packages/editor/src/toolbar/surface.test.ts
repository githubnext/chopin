import { describe, expect, it } from "bun:test";

import { CELL, ROW } from "./surface";

describe("immediate editor surfaces", () => {
	it("does not opt slash-menu or selection-toolbar controls into colour transitions", () => {
		for (let [surface, classes] of [["slash menu", ROW], ["selection toolbar", CELL]]) {
			expect({ surface, transitions: classes.split(/\s+/).includes("transition") }).toEqual({
				surface,
				transitions: false,
			});
		}
	});
});
