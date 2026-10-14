import { expect, test } from "bun:test";

import {
	chosenMachine,
	machineButtonLabel,
	machineDetail,
	machineRows,
	offlineChoice,
} from "./machine-choice";

import type { ChoosableMachine, MachineChoiceState } from "./machine-choice";

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

test("the button names the chosen machine and its state, or what automatic uses now", () => {
	expect(machineButtonLabel(state({ choice: "M_box" }))).toBe("Machine: build-box, connected");
	expect(
		machineButtonLabel(
			state({ choice: "M_box", machines: [machine({ connected: false })] }),
		),
	).toBe("Machine: build-box, offline");
	expect(
		machineButtonLabel(
			state({ choice: "M_box", machines: [machine({ reauthorize: true })] }),
		),
	).toBe("Machine: build-box, needs pairing again");
	expect(machineButtonLabel(state({ automatic: { id: "M_box", label: "build-box" } }))).toBe(
		"Machine: Automatic, uses build-box",
	);
	expect(machineButtonLabel(state())).toBe("Machine: Automatic, no machine connected");
	expect(machineButtonLabel(undefined)).toBe("Machine: Automatic");
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

test("each machine's line says its state, release and system, or when it was last seen", () => {
	expect(machineDetail(machine(), NOW)).toBe("Connected · chopin 0.0.5 · Linux");
	expect(machineDetail(machine({ version: null, platform: null }), NOW)).toBe("Connected");
	expect(
		machineDetail(machine({ connected: false, lastSeenAt: NOW - 3 * 3_600_000 }), NOW),
	).toBe("Offline · last seen 3h ago");
	expect(machineDetail(machine({ reauthorize: true }), NOW)).toBe("Needs pairing again");
});

test("the menu offers Automatic, then each machine, with offline ones disabled", () => {
	let rows = machineRows(
		state({
			choice: "M_box",
			automatic: null,
			machines: [machine(), machine({ id: "M_laptop", label: "laptop", connected: false })],
		}),
		NOW,
	);
	expect(rows.map(row => [row.id, row.label, row.checked, row.disabled])).toEqual([
		[null, "Automatic", false, false],
		["M_box", "build-box", true, false],
		["M_laptop", "laptop", false, true],
	]);
	expect(rows[0]!.detail).toBe("No machine connected now");
	expect(rows[2]!.detail).toStartWith("Offline");
	expect(
		machineRows(state({ automatic: { id: "M_box", label: "build-box" } }), NOW)[0]!.detail,
	).toBe("Uses build-box now");
});

test("Automatic names the machine it uses, saying when the favorite is offline; only the favorite's row is starred", () => {
	let studio = machine({ id: "M_studio", label: "studio" });
	let rows = machineRows(
		state({
			favorite: "M_box",
			automatic: { id: "M_box", label: "build-box", favorite: true },
			machines: [machine(), studio],
		}),
		NOW,
	);
	expect(rows[0]).toMatchObject({ uses: { label: "build-box", favorite: true }, note: undefined });
	// The star is the favorite's row's alone; Automatic's line only names the machine.
	expect(rows[0]!.detail).toBe("Uses build-box now");
	// Only the favorite's row is starred.
	expect(rows.map(row => row.favorite)).toEqual([false, true, false]);
	let fallen = machineRows(
		state({
			favorite: "M_box",
			automatic: { id: "M_studio", label: "studio", favorite: false },
			machines: [machine({ connected: false }), studio],
		}),
		NOW,
	);
	expect(fallen[0]).toMatchObject({
		uses: { label: "studio", favorite: false },
		note: "build-box is offline",
	});
	expect(fallen[0]!.detail).toBe("Uses studio now · build-box is offline");
});
