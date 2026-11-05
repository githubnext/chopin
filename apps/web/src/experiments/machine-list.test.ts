import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	finishingWords,
	groupMachines,
	machineMatches,
	machineState,
	platformName,
	SHARE_DETAIL,
	SharedWithYou,
	statusWords,
} from "./machine-list";

import type { Machine, TeammateMachine } from "../machine-summary";

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
	shared: false,
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

test("a machine that stopped being shared says how many teammate documents it is finishing", () => {
	expect(finishingWords({})).toBeUndefined();
	expect(finishingWords({ finishing: 0 })).toBeUndefined();
	expect(finishingWords({ finishing: 1 })).toBe("Finishing 1 teammate document");
	expect(finishingWords({ finishing: 2 })).toBe("Finishing 2 teammate documents");
});

test("sharing a machine says teammates' Planners, builds and runs run on it, as its owner", () => {
	for (let consent of ["Planner, builds and runs", "as you", "your GitHub account", "stay yours"]) {
		expect(SHARE_DETAIL).toContain(consent);
	}
	expect(SHARE_DETAIL).not.toContain("No one else's builds");
});

const theirs: TeammateMachine = {
	id: "t1",
	label: "build-box",
	teammate: true,
	owner: { login: "rival", avatarUrl: "https://example.test/rival.png" },
	repositories: ["octo-org/score", "octo-org/site", "octo-org/notes", "octo-org/docs"],
	connected: true,
	lastSeenAt: NOW,
	version: "0.1.5",
	service: true,
};

function shared(teammates: TeammateMachine[] | undefined) {
	return renderToStaticMarkup(
		createElement(SharedWithYou, { machines: { teammates } as never }),
	);
}

test("teammates' machines are listed read-only under Shared with you: owner, state, version, repositories", () => {
	let markup = shared([theirs]);
	expect(markup).toContain("Shared with you");
	expect(markup).toContain(">build-box<");
	expect(markup).toContain("rival");
	expect(markup).toContain("chopin 0.1.5");
	expect(markup).toContain("Connected");
	// A few repositories by name, the rest counted.
	expect(markup).toContain("octo-org/score");
	expect(markup).toContain("octo-org/site");
	expect(markup).not.toContain("octo-org/notes");
	expect(markup).toContain("2 more");
	// Grouped by kind, as the person's own are.
	expect(markup).toContain(">Cloud<");
	// Nothing changes the machine: no star, switch, rename, disconnect or actions menu.
	for (
		let managing of [
			"switch",
			"Actions",
			"favorite",
			"Set as favorite",
			"Disconnect",
			"Edit machine",
		]
	) expect(markup).not.toContain(managing);
	expect(markup).not.toContain("<button");
});

test("an offline teammate's machine says when it was last seen; none, or no answer yet, shows nothing", () => {
	// The table reads the clock itself, so the time is relative to it.
	expect(shared([{ ...theirs, connected: false, lastSeenAt: Date.now() - 3 * 3_600_000 }]))
		.toContain("Last seen 3h ago");
	expect(shared([])).toBe("");
	expect(shared(undefined)).toBe("");
});
