import { expect, test } from "bun:test";

import {
	chosenMachine,
	machineButtonLabel,
	machineRows,
	offlineChoice,
	plannerRunsOn,
	presence,
	shownMachine,
	showsMachineChoice,
} from "./machine-choice";

import type { ChoosableMachine, MachineChoiceState } from "./machine-choice";
import type { Machine, TeammateMachine } from "./machine-summary";

const NOW = Date.UTC(2026, 9, 14, 12);

function machine(overrides: Partial<ChoosableMachine> = {}): ChoosableMachine {
	return {
		id: "M_box",
		label: "build-box",
		connected: true,
		reauthorize: false,
		createdAt: NOW - 10_000,
		lastSeenAt: NOW,
		version: "0.0.5",
		hostname: "build-box",
		platform: { os: "linux", arch: "x64" },
		agent: null,
		service: true,
		planner: false,
		...overrides,
	};
}

function state(overrides: Partial<MachineChoiceState> = {}): MachineChoiceState {
	return { choice: null, favorite: null, automatic: null, machines: [machine()], ...overrides };
}

test("the button says what the document runs on: the choice, else what Automatic uses now", () => {
	expect(machineButtonLabel(state({ choice: "M_box" }))).toBe("Runs on build-box");
	expect(
		machineButtonLabel(state({ choice: "M_box", machines: [machine({ connected: false })] })),
	).toBe("Runs on build-box");
	expect(machineButtonLabel(state({ automatic: { id: "M_box", label: "build-box" } }))).toBe(
		"Runs on build-box",
	);
	expect(machineButtonLabel(state())).toBe("Runs on: no machine connected");
	expect(machineButtonLabel(undefined)).toBe("Runs on: no machine connected");
	expect(shownMachine(state({ automatic: { id: "M_box", label: null } }))?.id).toBe("M_box");
	expect(shownMachine(state())).toBeUndefined();
});

test("only a chosen machine that is offline stops Build, and says which", () => {
	expect(offlineChoice(state({ choice: "M_box" }))).toBeUndefined();
	expect(offlineChoice(state())).toBeUndefined();
	expect(
		offlineChoice(state({ choice: "M_box", machines: [machine({ connected: false })] })),
	).toBe("build-box is offline");
	// A choice the list no longer has (revoked in another tab) is automatic again.
	expect(chosenMachine(state({ choice: "M_gone" }))).toBeUndefined();
	expect(offlineChoice(state({ choice: "M_gone" }))).toBeUndefined();
});

test("the menu lists Local machines, then Cloud, each with its state, offline ones disabled", () => {
	let rows = machineRows(
		state({
			choice: "M_box",
			machines: [
				machine({ createdAt: NOW - 4_000 }),
				machine({
					id: "M_laptop",
					label: "laptop",
					connected: false,
					service: false,
					createdAt: NOW - 1_000,
				}),
				machine({ id: "M_air", label: "air", service: false, createdAt: NOW - 2_000 }),
				machine({
					id: "M_old",
					label: "old",
					connected: false,
					reauthorize: true,
					createdAt: NOW - 8_000,
				}),
			],
		}),
	);
	expect(rows.map(row => [row.id, row.cloud, row.checked, row.disabled, row.detail])).toEqual([
		["M_laptop", false, false, true, "Offline"],
		["M_air", false, false, false, "Connected"],
		["M_box", true, true, false, "Connected"],
		["M_old", true, false, true, "Needs reconnecting"],
	]);
});

test("with no choice the row Automatic uses is checked; there is no Automatic row or star", () => {
	let rows = machineRows(
		state({
			favorite: "M_box",
			automatic: { id: "M_studio", label: "studio" },
			machines: [
				machine({ createdAt: NOW - 1_000 }),
				machine({ id: "M_studio", label: "studio", createdAt: NOW - 2_000 }),
			],
		}),
	);
	expect(rows.map(row => [row.id, row.checked])).toEqual([["M_box", false], ["M_studio", true]]);
	expect(rows.every(row => !("favorite" in row))).toBe(true);
	expect(machineRows(state()).some(row => row.checked)).toBe(false);
});

test("the choice is read again when a machine goes offline, comes back or needs pairing again", () => {
	let box = { id: "m1", connected: true, reauthorize: false } as Machine;
	let laptop = { id: "m2", connected: false, reauthorize: false } as Machine;
	expect(presence(undefined)).toBeUndefined();
	expect(presence([box, laptop])).toBe(presence([laptop, box]));
	expect(presence([box, laptop])).not.toBe(presence([{ ...box, connected: false }, laptop]));
	expect(presence([box])).not.toBe(presence([{ ...box, reauthorize: true }]));
	expect(presence([box])).not.toBe(presence([box, laptop]));
	// What changes nothing a document shows doesn't read it again.
	expect(presence([box])).toBe(presence([{ ...box, label: "renamed", lastSeenAt: 5 }]));
});

test("the machine choice shows only once the person has a paired machine, connected or not", () => {
	let paired = { id: "M_box", connected: false } as Machine;
	// Not known yet, or none paired: no button and no Machine item anywhere.
	expect(showsMachineChoice(undefined)).toBe(false);
	expect(showsMachineChoice([])).toBe(false);
	// One paired machine, even offline, whatever repositories its checkouts are of.
	expect(showsMachineChoice([paired])).toBe(true);
	expect(showsMachineChoice([paired, { ...paired, id: "M_two", connected: true }])).toBe(true);
});

const theirs = { login: "rival", avatarUrl: "" };

function teammateMachine(overrides: Partial<ChoosableMachine> = {}): ChoosableMachine {
	return {
		id: "M_theirs",
		label: "desk",
		teammate: true,
		owner: theirs,
		connected: true,
		createdAt: NOW - 20_000,
		lastSeenAt: NOW,
		version: "0.1.5",
		service: false,
		runsPlanners: true,
		...overrides,
	};
}

test("the menu lists a teammate's machines plainly with the person's own, Local then Cloud, newest first in each, offline ones disabled", () => {
	let rows = machineRows(
		state({
			machines: [
				// Paired longest ago: last among the Local ones, though it is the person's own.
				machine({ id: "M_old", label: "old laptop", service: false, createdAt: NOW - 90_000 }),
				teammateMachine({ id: "M_a", label: "desk", createdAt: NOW - 5_000 }),
				machine({ id: "M_box", createdAt: NOW - 8_000 }),
				teammateMachine({
					id: "M_b",
					label: "rack",
					connected: false,
					service: true,
					createdAt: NOW - 1_000,
				}),
				machine({ id: "M_laptop", label: "laptop", service: false, createdAt: NOW - 60_000 }),
				teammateMachine({
					id: "M_c",
					label: "studio",
					owner: { login: "casey", avatarUrl: "" },
					createdAt: NOW - 70_000,
				}),
				teammateMachine({ id: "M_d", label: "lab", owner: theirs, createdAt: NOW - 95_000 }),
			],
		}),
	);
	// One Local list and one Cloud list, each newest first whoever owns the machine: a teammate's
	// machine paired after one of the person's own is above it, and before it is below it.
	expect(rows.map(row => [row.id, row.cloud, row.disabled])).toEqual([
		["M_a", false, false],
		["M_laptop", false, false],
		["M_c", false, false],
		["M_old", false, false],
		["M_d", false, false],
		["M_b", true, true],
		["M_box", true, false],
	]);
	// A teammate's machine says nothing of its owner's authorization, and is disabled only offline.
	expect(rows.find(row => row.id === "M_b")?.detail).toBe("Offline");
	expect(rows.every(row => row.owner === undefined)).toBe(true);
});

test("machines paired at the same moment keep one order in the menu whoever owns them", () => {
	let tied = [
		teammateMachine({ id: "M_b", label: "rack", createdAt: NOW }),
		machine({ id: "M_c", label: "laptop", service: false, createdAt: NOW }),
		machine({ id: "M_a", label: "desk", service: false, createdAt: NOW }),
	];
	let order = (machines: ChoosableMachine[]) => machineRows(state({ machines })).map(row => row.id);
	expect(order(tied)).toEqual(["M_a", "M_b", "M_c"]);
	expect(order([...tied].toReversed())).toEqual(["M_a", "M_b", "M_c"]);
});

test("a teammate's owner is named on its row only to tell it from a machine of the same name", () => {
	let rows = machineRows(
		state({
			machines: [
				machine({ id: "M_mine", label: "desk", service: false }),
				teammateMachine({ id: "M_a", label: "Desk" }),
				teammateMachine({ id: "M_b", label: "rack", owner: { login: "casey", avatarUrl: "" } }),
				teammateMachine({ id: "M_c", label: "rack" }),
			],
		}),
	);
	expect(rows.map(row => [row.id, row.owner])).toEqual([
		["M_mine", undefined],
		["M_a", "rival"],
		["M_b", "casey"],
		["M_c", "rival"],
	]);
});

test("a teammate's chosen machine is shown, and Build runs there unless it is offline", () => {
	let chosen = state({ choice: "M_theirs", machines: [machine(), teammateMachine()] });
	expect(machineButtonLabel(chosen)).toBe("Runs on desk");
	expect(machineRows(chosen).find(row => row.checked)?.id).toBe("M_theirs");
	// Online, it takes the person's builds like one of their own: nothing greys Build plan out.
	expect(offlineChoice(chosen)).toBeUndefined();
	// Offline, it says so, as one of their own does.
	expect(
		offlineChoice(
			state({ choice: "M_theirs", machines: [teammateMachine({ connected: false })] }),
		),
	).toBe("desk is offline");
	expect(offlineChoice(state({ choice: "M_box" }))).toBeUndefined();
});

test("a teammate's shared machine alone is enough to offer the machine choice", () => {
	expect(showsMachineChoice([], state({ machines: [teammateMachine()] }))).toBe(true);
	expect(showsMachineChoice(undefined, state({ machines: [teammateMachine()] }))).toBe(true);
	expect(showsMachineChoice([], state({ machines: [] }))).toBe(false);
	expect(showsMachineChoice(undefined, undefined)).toBe(false);
});

test("the choice is read again when a teammate's shared machine goes offline or comes back", () => {
	let box = { id: "m1", connected: true, reauthorize: false } as Machine;
	let desk = { id: "t1", connected: true } as TeammateMachine;
	expect(presence([box], [desk])).not.toBe(presence([box], [{ ...desk, connected: false }]));
	expect(presence([box], [desk])).not.toBe(presence([box], []));
	expect(presence([box], [desk])).toBe(presence([box], [{ ...desk, label: "renamed" }]));
	expect(presence([box])).toBe(presence([box], []));
});

test("names the machine a Planner is starting on or dropped from, only when the person can see it", () => {
	let runner = (planner: NonNullable<MachineChoiceState["planner"]>) => state({ planner });
	let on = { login: "mona", machine: "M_box" };
	expect(plannerRunsOn(runner({ state: "starting", ...on }))).toBe("build-box");
	expect(plannerRunsOn(runner({ state: "disconnected", ...on }))).toBe("build-box");
	// A machine the person cannot list is not named, so the status names whose it is instead.
	expect(plannerRunsOn(runner({ state: "starting", login: "mona", machine: "M_other" })))
		.toBeUndefined();
	// Attached is healthy, held is another account's, and none runs nowhere.
	expect(plannerRunsOn(runner({ state: "attached", ...on }))).toBeUndefined();
	expect(plannerRunsOn(runner({ state: "held", login: "mona", machine: null }))).toBeUndefined();
	expect(plannerRunsOn(runner({ state: "none", login: null, machine: null }))).toBeUndefined();
	expect(plannerRunsOn(undefined)).toBeUndefined();
	expect(plannerRunsOn(state())).toBeUndefined();
});
