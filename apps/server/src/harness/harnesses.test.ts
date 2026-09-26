import { expect, it } from "bun:test";

import { harnesses, harnessFor, registerCredential } from "./harnesses";

it("selects only the tested Copilot SDK harness", () => {
	expect(Object.keys(harnesses)).toEqual(["copilot-sdk"]);
	expect(harnessFor({ harness: "copilot-sdk" }).harnessId).toBe("copilot-sdk");
	expect(() => harnessFor({ harness: "not-installed" })).toThrow("Unknown harness: not-installed");
});

it("registers credentials per session without reuse or rewriting", () => {
	let token = "session-token";
	let release = registerCredential("session-id", () => token);
	expect(() => registerCredential("session-id", () => "other")).toThrow("already registered");
	try {
		token = "rotated-token";
	} finally {
		release();
	}
	let again = registerCredential("session-id", () => token);
	again();
});
