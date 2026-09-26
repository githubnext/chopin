import { expect, it } from "bun:test";

import { harnesses, harnessFor, registerCredential } from "./harnesses";

it("selects only the tested Copilot SDK harness", () => {
	expect(Object.keys(harnesses)).toEqual(["copilot-sdk"]);
	expect(harnessFor({ harness: "copilot-sdk" }).harnessId).toBe("copilot-sdk");
	expect(() => harnessFor({ harness: "not-installed" })).toThrow("Unknown harness: not-installed");
});

it("refuses host-login fallback on public binds but accepts it on loopback", () => {
	for (let host of ["0.0.0.0", "::", "192.168.1.2", "localhost.example"]) {
		expect(() => harnessFor({ harness: "copilot-sdk", harnessAuth: "auto", host }))
			.toThrow("requires a loopback SERVER_HOST");
	}
	for (let host of ["127.0.0.1", "127.42.0.1", "localhost", "::1", "[::1]"]) {
		expect(harnessFor({ harness: "copilot-sdk", harnessAuth: "auto", host }).harnessId)
			.toBe("copilot-sdk");
	}
	expect(harnessFor({ harness: "copilot-sdk", harnessAuth: "direct", host: "0.0.0.0" }).harnessId)
		.toBe("copilot-sdk");
	expect(() => harnessFor({ harness: "unknown", harnessAuth: "auto", host: "127.0.0.1" }))
		.toThrow("Unknown harness: unknown");
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
