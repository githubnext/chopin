import { expect, test } from "bun:test";
import {
	CONNECTOR_SANDBOX_FIX_HEADER,
	CONNECTOR_SANDBOX_HEADER,
	CONNECTOR_SANDBOX_HYPERVISOR_HEADER,
	CONNECTOR_SANDBOX_REASON_HEADER,
	parseSandboxReport,
	SANDBOX_TEXT_LIMIT,
	sandboxLabel,
	sandboxSummary,
} from "./connector";

function headers(values: Record<string, string>) {
	return (name: string) => values[name];
}

test("a machine is labelled with the hypervisor its microVMs run on", () => {
	expect(sandboxLabel({ engine: "nvx", hypervisor: "kvm" })).toBe(
		"Each agent in its own microVM (NVX on KVM)",
	);
	expect(sandboxLabel({ engine: "nvx", hypervisor: "whp" })).toBe(
		"Each agent in its own microVM (NVX on Windows Hypervisor Platform)",
	);
});

test("a machine that can't run agents says why and the one fix", () => {
	let report = {
		engine: "none" as const,
		reason: "Your user can't read and write /dev/kvm.",
		fix: "sudo usermod -aG kvm $USER",
	};
	expect(sandboxSummary(report)).toBe("Can't run agents: Your user can't read and write /dev/kvm.");
	expect(sandboxLabel(report)).toBe(
		"Can't run agents: Your user can't read and write /dev/kvm. Fix: sudo usermod -aG kvm $USER",
	);
	expect(sandboxLabel({ engine: "none", reason: "It is a Mac." })).toBe(
		"Can't run agents: It is a Mac.",
	);
});

test("the headers of a connector round-trip, and anything unexpected is read as saying nothing", () => {
	expect(
		parseSandboxReport(
			headers({ [CONNECTOR_SANDBOX_HEADER]: "nvx", [CONNECTOR_SANDBOX_HYPERVISOR_HEADER]: "kvm" }),
		),
	).toEqual({ engine: "nvx", hypervisor: "kvm" });
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
	// A connector from before the sandbox, a process sandbox of an earlier release, NVX on a
	// hypervisor this server doesn't know or none, a refusal with no reason, and text that isn't
	// plain or is too long.
	expect(parseSandboxReport(headers({}))).toBeUndefined();
	expect(parseSandboxReport(headers({ [CONNECTOR_SANDBOX_HEADER]: "bubblewrap" })))
		.toBeUndefined();
	expect(parseSandboxReport(headers({ [CONNECTOR_SANDBOX_HEADER]: "nvx" }))).toBeUndefined();
	expect(
		parseSandboxReport(
			headers({
				[CONNECTOR_SANDBOX_HEADER]: "nvx",
				[CONNECTOR_SANDBOX_HYPERVISOR_HEADER]: "constructor",
			}),
		),
	).toBeUndefined();
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
