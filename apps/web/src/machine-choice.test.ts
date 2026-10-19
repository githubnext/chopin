import { expect, test } from "bun:test";

import {
	chosenMachine,
	machineButtonLabel,
	machineRows,
	offlineChoice,
	presence,
	shownMachine,
	showsMachineChoice,
} from "./machine-choice";

import type { ChoosableMachine, MachineChoiceState } from "./machine-choice";
import type { Machine } from "./machine-summary";

const NOW = Date.UTC(2026, 9, 14, 12);

function machine(overrides: Partial<ChoosableMachine> = {}): ChoosableMachine {
	return {
		id: "M_box",
		label: "build-box",
		connected: true,
		reauthorize: false,
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
				machine(),
				machine({ id: "M_laptop", label: "laptop", connected: false, service: false }),
				machine({ id: "M_air", label: "air", service: false }),
				machine({ id: "M_old", label: "old", connected: false, reauthorize: true }),
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
			machines: [machine(), machine({ id: "M_studio", label: "studio" })],
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
