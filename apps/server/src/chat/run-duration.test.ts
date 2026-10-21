import { expect, test } from "bun:test";

import { runDuration } from "./run-duration";

test.each([
	[0.124, "0.1 s"],
	[0.96, "1 s"],
	[12, "12 s"],
	[12.4, "12 s"],
	[59.4, "59 s"],
])("a run of %p seconds reads %p", (seconds, text) => {
	expect(runDuration(seconds)).toBe(text);
});

test("a run that ended within the second it started does not claim a minute", () => {
	// Run cards carry whole seconds, so a 0.124 s run arrives as zero.
	expect(runDuration(0)).toBe("less than a second");
	expect(runDuration(0.04)).toBe("less than a second");
});

test.each([
	[59.6, "1 min"],
	[60, "1 min"],
	[600, "10 min"],
	[2_383, "40 min"],
])("a run of %p seconds reads in minutes as %p", (seconds, text) => {
	expect(runDuration(seconds)).toBe(text);
});

test("a clock that went backwards reads as no time rather than a negative one", () => {
	expect(runDuration(-5)).toBe("less than a second");
});
