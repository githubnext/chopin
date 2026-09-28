import { afterEach, expect, it } from "bun:test";

import { harnesses, harnessFor, registerCredential, shutdownHarnesses } from "./harnesses";

afterEach(shutdownHarnesses);

it("selects the tested Copilot SDK, Pi, and Atomic harnesses", () => {
	expect(Object.keys(harnesses)).toEqual(["copilot-sdk", "pi", "atomic"]);
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

it("requires an explicit, Pi-supported auth mode and refuses direct or unknown modes", () => {
	expect(() => harnessFor({ harness: "pi", host: "127.0.0.1" }))
		.toThrow("HARNESS_AUTH is required for harness pi");
	expect(() => harnessFor({ harness: "pi", harnessAuth: "direct", host: "127.0.0.1" }))
		.toThrow("is not a supported pi authentication mode");
	expect(() => harnessFor({ harness: "pi", harnessAuth: "bogus", host: "127.0.0.1" }))
		.toThrow("is not a supported pi authentication mode");
	expect(harnessFor({ harness: "pi", harnessAuth: "auto", host: "127.0.0.1" }).harnessId).toBe(
		"pi",
	);
});

it("refuses every Pi auth mode but ai-gateway on a non-loopback bind", () => {
	expect(() => harnessFor({ harness: "pi", harnessAuth: "auto", host: "0.0.0.0" }))
		.toThrow("must be ai-gateway");
	expect(() => harnessFor({ harness: "pi", harnessAuth: "custom", host: "0.0.0.0" }))
		.toThrow("must be ai-gateway");
	expect(harnessFor({ harness: "pi", harnessAuth: "ai-gateway", host: "0.0.0.0" }).harnessId)
		.toBe("pi");
});

it("requires an explicit, Atomic-supported auth mode and refuses direct or unknown modes", () => {
	expect(() => harnessFor({ harness: "atomic", host: "127.0.0.1" }))
		.toThrow("HARNESS_AUTH is required for harness atomic");
	for (let harnessAuth of ["direct", "openai", "custom", "bogus"]) {
		expect(() => harnessFor({ harness: "atomic", harnessAuth, host: "127.0.0.1" }))
			.toThrow(`HARNESS_AUTH ${harnessAuth} is not a supported atomic authentication mode`);
	}
	expect(harnessFor({ harness: "atomic", harnessAuth: "auto", host: "::1" }).harnessId)
		.toBe("atomic");
});

it("refuses Atomic's host-login auto mode on a non-loopback bind but accepts ai-gateway", () => {
	for (let host of ["0.0.0.0", "::", "192.168.1.2", "localhost.example"]) {
		expect(() => harnessFor({ harness: "atomic", harnessAuth: "auto", host }))
			.toThrow("HARNESS_AUTH for atomic on a non-loopback SERVER_HOST must be ai-gateway");
	}
	expect(harnessFor({ harness: "atomic", harnessAuth: "ai-gateway", host: "0.0.0.0" }).harnessId)
		.toBe("atomic");
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
