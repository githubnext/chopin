import { describe, expect, it } from "bun:test";

import { alignmentLabel, nextAlign } from "./alignment";

describe("the shared table alignment control", () => {
	it("cycles through every labelled alignment and back to default", () => {
		let values = [null, "left", "center", "right", null] as const;
		for (let index = 0; index < values.length - 1; index++) {
			expect(nextAlign(values[index])).toBe(values[index + 1]);
		}
		expect(values.map(alignmentLabel)).toEqual(["default", "left", "centre", "right", "default"]);
	});
});
