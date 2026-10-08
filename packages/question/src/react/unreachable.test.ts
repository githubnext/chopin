import { describe, expect, it } from "bun:test";

import { unreachable } from "./questionnaire-controller";

describe("unreachable", () => {
	it("recognises a request the connection could not carry", () => {
		for (let message of ["not connected", "connection lost", "connection restarted"]) {
			expect(unreachable(new Error(message))).toBe(true);
		}
	});

	it("leaves refusals and other failures to their own copy", () => {
		expect(unreachable(new Error("stale"))).toBe(false);
		expect(unreachable("not connected")).toBe(false);
	});
});
