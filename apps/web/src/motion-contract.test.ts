import { describe, expect, it } from "bun:test";

import { MOTION_STATES, motionContract } from "./motion-contract";

describe("motion contracts", () => {
	it("maps every planned surface to one class, close duration, and expected states", () => {
		expect(MOTION_STATES).toEqual(["", "is-open", "is-closing"]);
		expect(motionContract("popover")).toEqual({
			className: "motion-popover",
			closeDuration: 150,
			states: MOTION_STATES,
		});
		expect(motionContract("sidebar")).toEqual({
			className: "motion-sidebar",
			closeDuration: 180,
			states: MOTION_STATES,
		});
		expect(motionContract("collapse")).toEqual({
			className: "motion-collapse",
			closeDuration: 250,
			contentClassName: "motion-collapse-content",
			states: MOTION_STATES,
		});
		expect(motionContract("content-swap")).toEqual({
			className: "motion-content-swap",
			closeDuration: 250,
			states: MOTION_STATES,
		});
		expect(motionContract("feedback")).toEqual({
			className: "motion-feedback",
			closeDuration: 180,
			states: MOTION_STATES,
		});
	});
});
