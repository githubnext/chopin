import { expect, test } from "bun:test";
import {
	groupMachines,
	machineMatches,
	machineState,
	platformName,
	statusWords,
} from "./machine-list";

import type { Machine } from "../machine-summary";

const NOW = Date.UTC(2026, 9, 14, 12);
const base: Machine = {
	id: "m1",
	label: "build-box",
	autoRun: false,
	createdAt: NOW - 86_400_000,
	lastSeenAt: NOW - 3 * 3_600_000,
	connected: false,
	reauthorize: false,
	version: null,
	hostname: null,
	platform: null,
	agent: null,
	service: false,
	planner: false,
	favorite: false,
};

test("a machine's state and its words: connected, last seen, or needing to reconnect", () => {
	expect(machineState({ ...base, connected: true })).toBe("connected");
	expect(statusWords({ ...base, connected: true }, NOW)).toBe("Connected");
	expect(machineState(base)).toBe("offline");
	expect(statusWords(base, NOW)).toBe("Last seen 3h ago");
	expect(machineState({ ...base, connected: true, reauthorize: true })).toBe("reauthorize");
	expect(statusWords({ ...base, reauthorize: true }, NOW)).toBe("Needs reconnecting");
});

test("platforms read as people name them", () => {
	expect(platformName({ os: "linux", arch: "x64" })).toBe("Linux x64");
	expect(platformName({ os: "darwin", arch: "arm64" })).toBe("macOS arm64");
	expect(platformName({ os: "win32", arch: "x64" })).toBe("Windows x64");
	expect(platformName(null)).toBeUndefined();
});

test("search finds a machine by name, owner, host, version, agent or system", () => {
	let machine: Machine = {
		...base,
		version: "0.0.5",
		hostname: "build-box.local",
		platform: { os: "darwin", arch: "arm64" },
		agent: { name: "GitHub Copilot CLI", version: "1.0.97" },
	};
	for (let query of ["BUILD", "ada", "0.0.5", ".local", "copilot", "macos", ""]) {
		expect(machineMatches(machine, query, "ada"), query).toBe(true);
	}
	expect(machineMatches(machine, "windows", "ada")).toBe(false);
	expect(machineMatches(machine, "nobody", "ada")).toBe(false);
	// The owner is their login, with no suffix.
	expect(machineMatches(machine, "@github", "ada")).toBe(false);
});

test("search never matches a repository a machine has a checkout of; machines serve them all", () => {
	let listed = { ...base, repositories: ["octo-org/score", "octo-org/site"] } as Machine;
	for (let query of ["site", "octo-org/score", "score"]) {
		expect(machineMatches(listed, query, "ada"), query).toBe(false);
	}
});

test("machines group by kind, Local then Cloud, leaving out an empty group", () => {
	let laptop = { ...base, id: "a", label: "laptop" };
	let box = { ...base, id: "b", label: "box", service: true };
	let mini = { ...base, id: "c", label: "mini" };
	expect(
		groupMachines([box, laptop, mini]).map(group => [group.kind, group.machines.map(m => m.id)]),
	)
		.toEqual([["local", ["a", "c"]], ["cloud", ["b"]]]);
	expect(groupMachines([box]).map(group => group.kind)).toEqual(["cloud"]);
	expect(groupMachines([])).toEqual([]);
});
