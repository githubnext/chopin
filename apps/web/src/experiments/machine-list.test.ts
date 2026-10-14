import { expect, test } from "bun:test";
import { machineMatches, machineState, platformName, statusWords } from "./machine-list";

import type { Machine } from "../machine-summary";

const NOW = Date.UTC(2026, 9, 14, 12);
const base: Machine = {
	id: "m1",
	label: "build-box",
	repositories: ["octo-org/score", "octo-org/site"],
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

test("a machine's state and its words: connected, last seen, or needing pairing again", () => {
	expect(machineState({ ...base, connected: true })).toBe("connected");
	expect(statusWords({ ...base, connected: true }, NOW)).toBe("Connected");
	expect(machineState(base)).toBe("offline");
	expect(statusWords(base, NOW)).toBe("Last seen 3h ago");
	expect(machineState({ ...base, connected: true, reauthorize: true })).toBe("reauthorize");
	expect(statusWords({ ...base, reauthorize: true }, NOW)).toBe("Needs pairing again");
});

test("platforms read as people name them", () => {
	expect(platformName({ os: "linux", arch: "x64" })).toBe("Linux x64");
	expect(platformName({ os: "darwin", arch: "arm64" })).toBe("macOS arm64");
	expect(platformName({ os: "win32", arch: "x64" })).toBe("Windows x64");
	expect(platformName(null)).toBeUndefined();
});

test("search finds a machine by name, owner, repository, version, host, agent or system", () => {
	let machine: Machine = {
		...base,
		version: "0.0.5",
		hostname: "build-box.local",
		platform: { os: "darwin", arch: "arm64" },
		agent: { name: "GitHub Copilot CLI", version: "1.0.97" },
	};
	for (let query of ["BUILD", "ada", "site", "0.0.5", ".local", "copilot", "macos", ""]) {
		expect(machineMatches(machine, query, "ada"), query).toBe(true);
	}
	expect(machineMatches(machine, "windows", "ada")).toBe(false);
	expect(machineMatches(machine, "nobody", "ada")).toBe(false);
});
