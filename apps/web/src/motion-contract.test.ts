import { describe, expect, it } from "bun:test";

import { MOTION_STATES, motionContract } from "./motion-contract";

describe("motion contracts", () => {
	it("maps shell surfaces to one class, close duration, and shared states", () => {
		expect(MOTION_STATES).toEqual(["", "is-open", "is-closing"]);
		expect(motionContract("popover")).toEqual({
			className: "motion-popover",
			closeDuration: 150,
		});
		expect(motionContract("sidebar")).toEqual({
			className: "motion-sidebar",
			closeDuration: 180,
		});
	});
});
