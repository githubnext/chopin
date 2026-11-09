import { expect, test } from "bun:test";

import {
	afterRead,
	chosenMachine,
	machineButtonLabel,
	machineRows,
	offlineChoice,
	plannerLastSeen,
	plannerMachineName,
	plannerRunsOn,
	presence,
	shownMachine,
	showsMachineChoice,
} from "./machine-choice";

import { plannerShownAtOnce } from "./chat/planner-settle";
import { plannerStatus, plannerWithheld } from "./chat/planner-status";

import type { ChoosableMachine, MachineChoiceState } from "./machine-choice";
import type { Machine, TeammateMachine } from "./machine-summary";

/**
 * What the status is told of the machine, with the list read after the socket's last word, as it is
 * once the page has asked again, unless a case says the list is older.
 */
function told(
	...[state, planner, viewer, loading, current = true]: [
		MachineChoiceState | undefined,
		Parameters<typeof plannerMachineName>[1],
		string,
		boolean,
		boolean?,
	]
) {
	return plannerMachineName(state, planner, viewer, loading, current);
}

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

test("names the machine a Planner is starting on or dropped from only when it is the one the document runs on", () => {
	let both = [machine(), machine({ id: "M_laptop", label: "laptop" }), teammateMachine()];
	let runner = (
		planner: NonNullable<MachineChoiceState["planner"]>,
		base = state({ choice: "M_box" }),
	) => ({
		...base,
		machines: both,
		planner,
	});
	let on = { login: "mona", machine: "M_box" };
	expect(plannerRunsOn(runner({ state: "starting", ...on }))).toBe("build-box");
	expect(plannerRunsOn(runner({ state: "disconnected", ...on }))).toBe("build-box");
	// With no choice, the machine Automatic uses now is the one the button names.
	let automatic = state({ automatic: { id: "M_box", label: null } });
	expect(plannerRunsOn(runner({ state: "starting", ...on }, automatic))).toBe("build-box");
	// Another machine of the person's own than the one the document runs on is not named: a list
	// read before the choice changed still describes it, and the status waits for the list to agree.
	let laptop = { login: "mona", machine: "M_laptop" };
	expect(plannerRunsOn(runner({ state: "starting", ...laptop }))).toBeUndefined();
	expect(plannerRunsOn(runner({ state: "disconnected", ...laptop }))).toBeUndefined();
	expect(plannerRunsOn(runner({ state: "starting", ...laptop }, automatic))).toBeUndefined();
	expect(plannerRunsOn(runner({ state: "starting", ...laptop }, state()))).toBeUndefined();
	// It is named once it is the document's own.
	expect(plannerRunsOn(runner({ state: "starting", ...laptop }, state({ choice: "M_laptop" }))))
		.toBe("laptop");
	// A teammate's machine is named when it is the document's own, the one its button names.
	let theirs = { state: "starting" as const, login: "casey", machine: "M_theirs" };
	expect(plannerRunsOn(runner(theirs, state({ choice: "M_theirs" })))).toBe("desk");
	expect(plannerRunsOn(runner(theirs, state({ automatic: { id: "M_theirs", label: null } }))))
		.toBe("desk");
	// Not when the document runs on another machine, or none is known yet: whose it is is said
	// instead, never its name.
	expect(plannerRunsOn(runner(theirs, state({ choice: "M_box" })))).toBeUndefined();
	expect(plannerRunsOn(runner(theirs, state()))).toBeUndefined();
	expect(plannerRunsOn(runner({ ...theirs, state: "disconnected" }))).toBeUndefined();
	// A machine the person cannot list is not named either.
	expect(plannerRunsOn(runner({ state: "starting", login: "mona", machine: "M_other" })))
		.toBeUndefined();
	// Attached is healthy, held is another account's, and none runs nowhere.
	expect(plannerRunsOn(runner({ state: "attached", ...on }))).toBeUndefined();
	expect(plannerRunsOn(runner({ state: "held", login: "mona", machine: null }))).toBeUndefined();
	expect(plannerRunsOn(runner({ state: "none", login: null, machine: null }))).toBeUndefined();
	expect(plannerRunsOn(undefined)).toBeUndefined();
	expect(plannerRunsOn(state())).toBeUndefined();
});

function starting(login: string) {
	return { state: "starting" as const, login };
}

test("gives the time a machine of the person's own, or the document's, was last seen only while it is offline", () => {
	let away = machine({ connected: false, lastSeenAt: NOW - 3_600_000 });
	let dropped = (planner: NonNullable<MachineChoiceState["planner"]>, machines = [away]) =>
		state({ choice: "M_box", machines, planner });
	let on = { login: "mona", machine: "M_box" };
	expect(plannerLastSeen(dropped({ state: "disconnected", ...on }))).toBe(
		new Date(NOW - 3_600_000).toISOString(),
	);
	// Connected, it was seen just now, which is no news: the Planner alone is what dropped.
	expect(plannerLastSeen(dropped({ state: "disconnected", ...on }, [machine()]))).toBeUndefined();
	expect(plannerLastSeen(dropped({ state: "starting", ...on }))).toBeUndefined();
	expect(plannerLastSeen(dropped({ state: "attached", ...on }))).toBeUndefined();
	// Not one the status names, not a time it may borrow.
	expect(plannerLastSeen(dropped({ state: "disconnected", login: "mona", machine: "M_x" })))
		.toBeUndefined();
	let other = machine({
		id: "M_other",
		label: "other",
		connected: false,
		lastSeenAt: NOW - 7_200_000,
	});
	expect(
		plannerLastSeen(
			dropped({ state: "disconnected", login: "mona", machine: "M_other" }, [away, other]),
		),
	).toBeUndefined();
	expect(plannerLastSeen(undefined)).toBeUndefined();
});

test("names a machine only for the runner the socket describes: a poll of another account's Planner says nothing", () => {
	let alice = { login: "alice", avatarUrl: "" };
	let boxA = teammateMachine({ id: "M_a", label: "Box A", owner: alice });
	let polled = state({
		choice: "M_a",
		machines: [machine(), boxA],
		planner: { state: "starting", login: "alice", machine: "M_a" },
	});
	// The poll and the socket describe alice's Planner: the machine is named.
	expect(told(polled, starting("alice"), "mona", true)).toBe("Box A");
	// bob's Planner dropped after the poll was read: Box A is not his machine, nor said of him.
	expect(told(polled, { state: "disconnected", login: "bob" }, "mona", true))
		.toBeNull();
	expect(told(polled, starting("bob"), "mona", true)).toBeNull();
	let failing = { ...starting("bob"), failure: { attempts: 3, reason: "exit 1", at: "x" } };
	expect(told(polled, failing, "mona", true)).toBeNull();
	// A machine of the viewer's own is polled with no login, and is theirs: the socket must say
	// their own account, whatever its case.
	let own = state({
		choice: "M_box",
		planner: { state: "starting", login: null, machine: "M_box" },
	});
	expect(told(own, starting("Mona"), "mona", true)).toBe("build-box");
	expect(told(own, starting("bob"), "mona", true)).toBeNull();
	// Nothing is lent where nobody names a machine anyway.
	expect(told(polled, { state: "held", login: "bob", until: "x" }, "mona", true))
		.toBeUndefined();
	expect(told(polled, { state: "none" }, "mona", true)).toBeUndefined();
});

test("waits for the list when it names a teammate's machine for the person's own Planner, and names a teammate's by its owner", () => {
	let both = [machine(), teammateMachine()];
	let listed = state({ machines: both });
	// Their machines are loading: nothing yet, but only where they will load.
	expect(told(undefined, starting("mona"), "mona", true)).toBeNull();
	expect(told(undefined, starting("mona"), "mona", false)).toBeUndefined();
	// Named when the list names it.
	let named = {
		...listed,
		choice: "M_box",
		planner: { state: "starting" as const, login: "mona", machine: "M_box" },
	};
	expect(told(named, starting("mona"), "mona", true)).toBe("build-box");
	// The list names a teammate's machine, which the document does not run on, while the person's
	// own account is the one starting it: that name is not lent to it, nor their own login said.
	let theirs = {
		...listed,
		planner: { state: "starting" as const, login: "casey", machine: "M_theirs" },
	};
	expect(told(theirs, starting("mona"), "Mona", true)).toBeNull();
	expect(told(theirs, { state: "disconnected", login: "mona" }, "mona", true))
		.toBeNull();
	// Someone else's machine is named by its owner's login, which the status writes.
	expect(told(theirs, starting("casey"), "mona", true)).toBeUndefined();
	// A Planner the list knows nothing of, such as an agent client of their own with no machine,
	// is the status's to name by login.
	let alone = { ...listed, planner: { state: "none" as const, login: null, machine: null } };
	expect(told(alone, starting("mona"), "mona", true)).toBeUndefined();
	expect(told(alone, { state: "disconnected", login: "mona" }, "mona", true))
		.toBeUndefined();
	// Nothing to name while it is attached or no machine is asked.
	expect(told(alone, { state: "attached", login: "mona" }, "mona", true))
		.toBeUndefined();
	expect(told(alone, { state: "none" }, "mona", true)).toBeUndefined();
});

test("names a machine only when it is the one the document runs on, and says nothing while a list still describes another machine of the person's own", () => {
	let boxA = machine({ id: "M_a", label: "Box A" });
	let boxB = machine({ id: "M_b", label: "Box B" });
	let listed = (
		planner: NonNullable<MachineChoiceState["planner"]>,
		base: Partial<MachineChoiceState> = { choice: "M_b" },
	) => state({ machines: [boxA, boxB], planner, ...base });
	let onA = { login: null, machine: "M_a" };
	let onB = { login: null, machine: "M_b" };
	let failure = { attempts: 3, reason: "exit 1", at: new Date(NOW).toISOString() };
	let words = [
		starting("mona"),
		{ state: "disconnected" as const, login: "mona" },
		{ ...starting("mona"), failure },
	];
	// The document was set to run on Box B after the list was read, and the list still says the
	// Planner is on Box A, the person's own as well: Box A is not named, nor is anything said.
	for (let word of words) {
		for (let runner of ["starting", "disconnected"] as const) {
			expect(told(listed({ state: runner, ...onA }), word, "mona", true)).toBeNull();
		}
	}
	// With no choice, the machine Automatic uses now is the one the button names.
	let automatic = { choice: null, automatic: { id: "M_b", label: "Box B" } };
	for (let word of words) {
		expect(told(listed({ state: "starting", ...onA }, automatic), word, "mona", true))
			.toBeNull();
	}
	// The list catches up, and the document's own machine is named.
	for (let word of words) {
		expect(told(listed({ state: "starting", ...onB }), word, "mona", true))
			.toBe("Box B");
		expect(told(listed({ state: "disconnected", ...onB }), word, "mona", true))
			.toBe("Box B");
		expect(told(listed({ state: "starting", ...onB }, automatic), word, "mona", true))
			.toBe("Box B");
	}
	// Another account's Planner on that machine is told by its login, as the status writes it.
	expect(told(listed({ state: "starting", ...onA }), starting("casey"), "mona", true))
		.toBeUndefined();
});

test("says nothing of a machine while the list was read before the socket's word, however well it agrees with itself", () => {
	let boxB = machine({ id: "M_b", label: "Box B" });
	let listed = state({
		choice: "M_b",
		machines: [machine({ id: "M_a", label: "Box A" }), boxB],
		planner: { state: "starting", login: null, machine: "M_b" },
	});
	let failure = { attempts: 3, reason: "exit 1", at: new Date(NOW).toISOString() };
	let words = [
		starting("mona"),
		{ state: "disconnected" as const, login: "mona" },
		{ ...starting("mona"), failure },
	];
	for (let word of words) {
		// It names Box B, which is the choice and where the Planner was: the Planner may have moved
		// since, so it says nothing until a read that began after the word has answered.
		expect(told(listed, word, "mona", true, false)).toBeNull();
		expect(told(listed, word, "mona", true, true)).toBe("Box B");
	}
	// Whose machine it is by login waits as well: the list is how it is known not to be the person's own.
	let mine = state({ machines: [] });
	expect(told(mine, starting("casey"), "mona", true, false)).toBeNull();
	expect(told(mine, starting("casey"), "mona", true, true)).toBeUndefined();
	// A word that names no machine anyway, and a page with no list to be older, are unaffected.
	for (let word of [{ state: "attached" as const, login: "mona" }, { state: "none" as const }]) {
		expect(told(listed, word, "mona", true, false)).toBeUndefined();
	}
	expect(told(undefined, starting("mona"), "mona", false, false)).toBeUndefined();
	expect(told(undefined, starting("mona"), "mona", true, false)).toBeNull();
});

test("a word that waits for a newer read of the list says nothing, never what the status said of an older word, and is drawn at once", () => {
	let listed = state({
		choice: "M_box",
		planner: { state: "starting", login: null, machine: "M_box" },
	});
	let failure = { attempts: 3, reason: "exit 1", at: new Date(NOW).toISOString() };
	// What the status said of the word before, from a list that named Box B.
	let before = plannerStatus(starting("mona"), "Box B");
	expect(before).toBeDefined();
	for (
		let word of [
			starting("mona"),
			{ state: "disconnected" as const, login: "mona" },
			{ ...starting("mona"), failure },
		]
	) {
		let name = told(listed, word, "mona", true, false);
		expect(name).toBeNull();
		expect(plannerWithheld(word, name)).toBe(true);
		let status = plannerStatus(word, name);
		// Nothing, not the earlier status, and not held for the list: it is drawn as nothing at once.
		expect(status).toBeUndefined();
		expect(plannerShownAtOnce(before, status)).toBe(true);
		// A read that began after the word names it, and the word is no longer withheld.
		let named = told(listed, word, "mona", true, true);
		expect(named).toBe("build-box");
		expect(plannerWithheld(word, named)).toBe(false);
		expect(plannerStatus(word, named)).toBeDefined();
	}
	// What names no machine, and says a state clearing, goes at once and is not withheld.
	for (let word of [{ state: "attached" as const, login: "mona" }, { state: "none" as const }]) {
		let name = told(listed, word, "mona", true, false);
		expect(plannerWithheld(word, name)).toBe(false);
	}
});

test("a read that says what the choice held changes nothing the page draws, unless a word of the socket's came between the two reads", () => {
	let held = { state: state({ choice: "M_box" }), read: 5 };
	// The same answer in a new object, read right after the one before it: the very same hold, so
	// the room that draws it does not render again, and neither does the next one read after that,
	// though the hold still says where the first of them began.
	let same = state({ choice: "M_box" });
	expect(afterRead(held, same, 6, 5)).toBe(held);
	expect(afterRead(held, same, 7, 6)).toBe(held);
	// Another number was minted between two reads, a word of the socket's: this read began after it
	// and the last one before, so which of the two is current changes, and the hold must move.
	let later = afterRead(held, same, 8, 6);
	expect(later).toEqual({ state: held.state, read: 8 });
	expect(later.state).toBe(held.state);
	// A different answer replaces the state, whatever the numbers; so does the first one.
	let moved = state({ choice: "M_box", machines: [machine({ connected: false })] });
	expect(afterRead(held, moved, 6, 5)).toEqual({ state: moved, read: 6 });
	expect(afterRead({ read: 0 }, same, 1, 0)).toEqual({ state: same, read: 1 });
});
