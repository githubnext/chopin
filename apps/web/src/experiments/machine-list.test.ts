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
	statusWords,
	YourMachines,
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
	sandbox: null,
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

test("sharing a machine says teammates' replies, builds and runs happen on it, as its owner", () => {
	for (let consent of ["replies, builds and runs", "as you", "your GitHub account", "stay yours"]) {
		expect(SHARE_DETAIL).toContain(consent);
	}
	expect(SHARE_DETAIL).not.toContain("No one else's builds");
});

const theirs: TeammateMachine = {
	id: "t1",
	label: "rack",
	teammate: true,
	owner: { login: "rival", avatarUrl: "https://example.test/rival.png" },
	repositories: ["octo-org/score", "octo-org/site"],
	connected: true,
	createdAt: NOW - 3_600_000,
	lastSeenAt: NOW,
	version: "0.1.5",
	service: true,
	favorite: false,
};

function table(own: Machine[] | undefined, teammates: TeammateMachine[] | undefined) {
	return renderToStaticMarkup(
		createElement(YourMachines, {
			owner: { login: "ada" },
			machines: { machines: own, teammates, error: "", recommended: null } as never,
		}),
	);
}

/** The table's rows with `name` in them, as markup. */
function row(markup: string, name: string) {
	return markup.split("<tr").find(value => value.includes(`>${name}<`)) ?? "";
}

test("teammates' machines are in the one table with the person's own, under Local and Cloud, and counted", () => {
	let markup = table([{ ...base, label: "laptop" }, { ...base, id: "m2", label: "box" }], [theirs]);
	expect(markup).not.toContain("Shared with you");
	expect(markup).toContain("3 machines");
	expect(markup.match(/<table/g)).toHaveLength(1);
	// Local holds the person's own, Cloud the teammate's server, as one table with the same columns.
	expect(markup).toContain(">Local<");
	expect(markup).toContain(">Cloud<");
	for (let column of ["Machine", "Owner", "Host", "Version", "Agent", "Shared", "Last seen"]) {
		expect(markup).toContain(`>${column}<`);
	}
	expect(markup.indexOf(">laptop<")).toBeLessThan(markup.indexOf(">rack<"));
	// A teammate's row fills what the API gives it: name, owner, release and state.
	let theirRow = row(markup, "rack");
	expect(theirRow).toContain("rival");
	expect(theirRow).toContain("chopin 0.1.5");
	expect(theirRow).toContain("Connected");
	// The person's own row says it is theirs.
	expect(row(markup, "laptop")).toContain("ada");
});

test("a teammate's machine is in the table where its age puts it among the person's own, in Local and Cloud", () => {
	let own = (id: string, label: string, createdAt: number, service = false): Machine => ({
		...base,
		id,
		label,
		createdAt,
		service,
	});
	let shared = (id: string, label: string, createdAt: number, service: boolean) => ({
		...theirs,
		id,
		label,
		createdAt,
		service,
	});
	let markup = table(
		[
			own("m1", "oldest", NOW - 9_000_000),
			own("m2", "newest", NOW),
			own("m3", "owncloud", NOW - 6_000_000, true),
		],
		[
			shared("t1", "middle", NOW - 5_000_000, false),
			shared("t2", "oldcloud", NOW - 8_000_000, true),
			shared("t3", "newcloud", NOW - 100, true),
		],
	);
	// Each group is newest first whoever owns the machine, so no group of the person's own comes first.
	let names = ["newest", "middle", "oldest", "newcloud", "owncloud", "oldcloud"];
	expect(names.toSorted((a, b) => markup.indexOf(`>${a}<`) - markup.indexOf(`>${b}<`))).toEqual(
		names,
	);
	expect(markup.indexOf(">oldest<")).toBeLessThan(markup.indexOf(">Cloud<"));
	expect(markup.indexOf(">Cloud<")).toBeLessThan(markup.indexOf(">newcloud<"));
});

test("the count counts a teammate's machine alone, and one machine reads as one", () => {
	expect(table([], [theirs])).toContain("1 machine<");
	expect(table([base], [])).toContain("1 machine<");
	expect(table([], [])).toBe("");
});

test("a teammate's row shows its Shared switch on and out of reach, and nothing only its owner changes", () => {
	let markup = table([{ ...base, shared: false, label: "laptop" }], [theirs]);
	let theirRow = row(markup, "rack");
	let theirSwitch = theirRow.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";
	expect(theirSwitch).toContain('aria-checked="true"');
	expect(theirSwitch).toContain("disabled");
	// No actions menu: rename, disconnect, setup and update are the owner's. The star is the person's own.
	expect(theirRow).not.toContain("Actions for");
	expect(theirRow).not.toContain("Update");
	expect(theirRow).toContain("Favorite rack");
	// The person's own row has the menu, and a switch that works.
	let ownRow = row(markup, "laptop");
	expect(ownRow).toContain("Actions for laptop");
	let ownSwitch = ownRow.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";
	expect(ownSwitch).toContain('aria-checked="false"');
	expect(ownSwitch).not.toContain("disabled");
});

test("a teammate's machine can be the favorite, and shows it", () => {
	let markup = table([base], [{ ...theirs, favorite: true }]);
	expect(row(markup, "rack")).toContain("Remove rack as favorite");
	expect(row(markup, "build-box")).toContain("Favorite build-box");
});

test("search finds a teammate's machine by its owner, and its name; it has no host or agent to match", () => {
	let box = { ...base, hostname: "ada-host" } as Machine;
	expect(machineMatches(theirs, "rival", "ada")).toBe(true);
	expect(machineMatches(theirs, "rack", "ada")).toBe(true);
	expect(machineMatches(theirs, "0.1.5", "ada")).toBe(true);
	// The person's own login is not its owner.
	expect(machineMatches(theirs, "ada", "ada")).toBe(false);
	expect(machineMatches(theirs, "ada-host", "ada")).toBe(false);
	expect(machineMatches(box, "ada-host", "ada")).toBe(true);
});

test("a teammate's machine is a Cloud machine here as it is in a document's menu, and groups with the person's", () => {
	expect(
		groupMachines([base, theirs, { ...base, id: "c", service: true }]).map(group => [
			group.kind,
			group.machines.map(value => value.id),
		]),
	).toEqual([["local", ["m1"]], ["cloud", ["t1", "c"]]]);
});
