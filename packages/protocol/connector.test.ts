import { expect, test } from "bun:test";
import {
	CONNECTOR_SANDBOX_FIX_HEADER,
	CONNECTOR_SANDBOX_HEADER,
	CONNECTOR_SANDBOX_REASON_HEADER,
	parseSandboxReport,
	SANDBOX_TEXT_LIMIT,
	sandboxLabel,
	sandboxSummary,
} from "./connector";

function headers(values: Record<string, string>) {
	return (name: string) => values[name];
}

test("a sandboxed machine is labelled with the sandbox its system gives", () => {
	expect(sandboxLabel({ engine: "seatbelt" })).toBe("Sandboxed (macOS Seatbelt)");
	expect(sandboxLabel({ engine: "bubblewrap" })).toBe("Sandboxed (Linux bubblewrap)");
	expect(sandboxLabel({ engine: "processcontainer" })).toBe("Sandboxed (Windows ProcessContainer)");
});

test("a machine with none says why and the one fix", () => {
	let report = {
		engine: "none" as const,
		reason: "slirp4netns isn't installed.",
		fix: "sudo apt-get install -y slirp4netns",
	};
	expect(sandboxSummary(report)).toBe("Not sandboxed: slirp4netns isn't installed.");
	expect(sandboxLabel(report)).toBe(
		"Not sandboxed: slirp4netns isn't installed. Fix: sudo apt-get install -y slirp4netns",
	);
	expect(sandboxLabel({ engine: "none", reason: "It is turned off." })).toBe(
		"Not sandboxed: It is turned off.",
	);
});

test("the headers of a connector round-trip, and anything unexpected is read as saying nothing", () => {
	expect(parseSandboxReport(headers({ [CONNECTOR_SANDBOX_HEADER]: "bubblewrap" }))).toEqual({
		engine: "bubblewrap",
	});
	expect(
		parseSandboxReport(
			headers({
				[CONNECTOR_SANDBOX_HEADER]: "none",
				[CONNECTOR_SANDBOX_REASON_HEADER]: "no slirp4netns",
				[CONNECTOR_SANDBOX_FIX_HEADER]: "sudo apt-get install -y slirp4netns",
			}),
		),
	).toEqual({
		engine: "none",
		reason: "no slirp4netns",
		fix: "sudo apt-get install -y slirp4netns",
	});
	// A connector from before the sandbox, a sandbox this server doesn't know, a refusal with
	// no reason, and text that isn't plain or is too long.
	expect(parseSandboxReport(headers({}))).toBeUndefined();
	expect(parseSandboxReport(headers({ [CONNECTOR_SANDBOX_HEADER]: "firecracker" })))
		.toBeUndefined();
	expect(parseSandboxReport(headers({ [CONNECTOR_SANDBOX_HEADER]: "constructor" })))
		.toBeUndefined();
	expect(parseSandboxReport(headers({ [CONNECTOR_SANDBOX_HEADER]: "none" }))).toBeUndefined();
	expect(
		parseSandboxReport(
			headers({
				[CONNECTOR_SANDBOX_HEADER]: "none",
				[CONNECTOR_SANDBOX_REASON_HEADER]: "caf\u00e9",
			}),
		),
	).toBeUndefined();
	expect(
		parseSandboxReport(
			headers({
				[CONNECTOR_SANDBOX_HEADER]: "none",
				[CONNECTOR_SANDBOX_REASON_HEADER]: "x".repeat(SANDBOX_TEXT_LIMIT + 1),
			}),
		),
	).toBeUndefined();
	expect(
		parseSandboxReport(
			headers({
				[CONNECTOR_SANDBOX_HEADER]: "none",
				[CONNECTOR_SANDBOX_REASON_HEADER]: "no tool",
				[CONNECTOR_SANDBOX_FIX_HEADER]: "x".repeat(SANDBOX_TEXT_LIMIT + 1),
			}),
		),
	).toEqual({ engine: "none", reason: "no tool" });
});
