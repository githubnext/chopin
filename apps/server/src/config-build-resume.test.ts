import { expect, test } from "bun:test";
import { configured } from "./config-conversation.test-fixtures";

test("CHOPIN_BUILD_RESUME_MS defaults to ten minutes", () => {
	expect(configured().buildResumeMs).toBe(600_000);
});

test("CHOPIN_BUILD_RESUME_MS accepts whole milliseconds within its bounds", () => {
	for (let value of ["1000", "90000", "3600000"]) {
		expect(configured({ CHOPIN_BUILD_RESUME_MS: value }).buildResumeMs).toBe(Number(value));
	}
});

test("CHOPIN_BUILD_RESUME_MS rejects out-of-range and malformed values", () => {
	for (let value of ["", "999", "3600001", "-1", "6e5", "600.5", "ten"]) {
		expect(() => configured({ CHOPIN_BUILD_RESUME_MS: value })).toThrow(
			"CHOPIN_BUILD_RESUME_MS must be an integer between 1000 and 3600000 milliseconds",
		);
	}
});
