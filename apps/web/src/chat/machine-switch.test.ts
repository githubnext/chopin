import { expect, test } from "bun:test";

import { switchedStatus, switchFor, switchSaved } from "./machine-switch";
import { plannerDrawn, plannerRemembered } from "./planner-settle";
import { plannerSentence, plannerStatus } from "./planner-status";

import type { MachineChoiceState } from "../machine-choice";
import type { MachineSwitch } from "./machine-switch";
import type { PlannerMemory } from "./planner-settle";
import type { PlannerStatus } from "./planner-status";
import type { Session } from "@chopin/protocol";

const AT = "2026-11-04T18:29:00.000Z";

function box(id: string, label: string) {
	return {
		id,
		label,
		connected: true,
		reauthorize: false,
		createdAt: 1,
		lastSeenAt: 1,
		version: null,
		hostname: null,
		platform: null,
		agent: null,
		service: false,
		planner: true,
	};
}

const STATE: MachineChoiceState = {
	choice: "a",
	favorite: null,
	automatic: null,
	machines: [box("a", "Box A"), box("b", "Box B")],
};

test("a switch starts only for a named machine other than the one shown, where the person's choice places it", () => {
	expect(switchFor(STATE, "b", 7, "a")).toEqual({ to: "Box B", machine: "b", began: 7 });
	expect(switchFor(STATE, "a", 7, "a")).toBeUndefined();
	expect(switchFor(STATE, null, 7, "a")).toBeUndefined();
	expect(switchFor(STATE, "gone", 7, "a")).toBeUndefined();
	expect(switchFor({ ...STATE, creatorDecides: true }, "b", 7, "a")).toBeUndefined();
	expect(switchFor(undefined, "b", 7, "a")).toBeUndefined();
});

test("a saved switch carries on only while the server says the Planner starts on the machine chosen", () => {
	let change: MachineSwitch = { to: "Box B", machine: "b", began: 7 };
	let saved = (planner: MachineChoiceState["planner"]) =>
		switchSaved(change, { ...STATE, planner });
	expect(saved({ state: "starting", login: "mona", machine: "b" })).toBe(true);
	expect(saved({ state: "starting", login: "mona", machine: "a" })).toBe(false);
	expect(saved({ state: "attached", login: "mona", machine: "b" })).toBe(false);
	expect(saved(undefined)).toBe(false);
});

/**
 * One step of what the page draws: the switch's status, then the settled status as
 * `useSettledPlannerStatus` draws it (no grace runs out within a switch: each step is at once).
 */
type Step = {
	planner?: Session.PlannerAttachment;
	/** The machine the list names for it; null while the list is read again. */
	name?: string | null;
	saving?: boolean;
	heard?: number;
};

function drawnThrough(change: MachineSwitch | undefined, steps: Step[], start: PlannerMemory) {
	let memory = start;
	let chosen = 1;
	// What was drawn before the click.
	let drawn: string[] = [start.shown ? plannerSentence(start.shown) : "quiet"];
	let live = change;
	for (let step of steps) {
		let real = plannerStatus(step.planner, step.name, undefined);
		let withheld = step.name === null
			&& (step.planner?.state === "starting" || step.planner?.state === "disconnected");
		let switched = switchedStatus(live, {
			status: real,
			saving: !!step.saving,
			heard: step.heard,
			withheld,
		});
		let mid = !!live && !switched.over;
		if (switched.over) live = undefined;
		let status: PlannerStatus | undefined = mid ? switched.status : real;
		let held = !mid && withheld;
		let asked = chosen > (memory.chosen ?? 0);
		let shown = plannerDrawn(memory.shown, status, false, held, memory.gapped, asked);
		memory = plannerRemembered(memory, status, false, held, false, chosen);
		let words = shown ? plannerSentence(shown) : "quiet";
		if (drawn.at(-1) !== words) drawn.push(words);
	}
	return drawn;
}

const A_STARTING = { state: "starting", login: "mona" } as const;
const CHANGE: MachineSwitch = { to: "Box B", machine: "b", began: 10 };

test("from a machine being connected to, a switch is connecting to the new one once, then quiet as it attaches", () => {
	let start: PlannerMemory = { shown: plannerStatus(A_STARTING, "Box A"), gapped: false };
	expect(drawnThrough(CHANGE, [
		// The click: saving, the old word still held, the list read again.
		{ planner: A_STARTING, name: null, saving: true, heard: 5 },
		// The server's word arrives while the choice is saved, then the save, the list not read yet.
		{ planner: A_STARTING, name: null, saving: true, heard: 11 },
		{ planner: A_STARTING, name: null, heard: 11 },
		// The list is read: the word is known as Box B's.
		{ planner: A_STARTING, name: "Box B", heard: 11 },
		{ planner: { state: "attached", login: "mona" }, heard: 12 },
	], start)).toEqual(["Connecting to Box A", "Connecting to Box B", "quiet"]);
});

test("from an attached machine, a switch is connecting to the new one from the click, never quiet in between", () => {
	let start: PlannerMemory = { shown: undefined, gapped: false };
	expect(drawnThrough(CHANGE, [
		// The old machine's word says attached until the server's next one.
		{ planner: { state: "attached", login: "mona" }, saving: true, heard: 5 },
		{ planner: { state: "attached", login: "mona" }, heard: 5 },
		{ planner: A_STARTING, name: null, heard: 11 },
		{ planner: A_STARTING, name: "Box B", heard: 11 },
		{ planner: { state: "attached", login: "mona" }, heard: 12 },
	], start)).toEqual(["quiet", "Connecting to Box B", "quiet"]);
});

test("a switch to a machine that can't start goes from connecting to the can't-start state, with nothing between", () => {
	let start: PlannerMemory = { shown: undefined, gapped: false };
	let failing = {
		state: "starting",
		login: "mona",
		failure: { attempts: 2, reason: "exit 1", at: AT },
	} as const;
	expect(drawnThrough(CHANGE, [
		{ planner: { state: "attached", login: "mona" }, saving: true, heard: 5 },
		{ planner: A_STARTING, name: null, heard: 11 },
		{ planner: A_STARTING, name: "Box B", heard: 11 },
		{ planner: failing, name: "Box B", heard: 14 },
	], start)).toEqual(["quiet", "Connecting to Box B", "Can't connect to Box B."]);
});

test("a switch to a machine that never answers stays connecting, once", () => {
	let start: PlannerMemory = { shown: plannerStatus(A_STARTING, "Box A"), gapped: false };
	let steps: Step[] = [{ planner: A_STARTING, name: null, saving: true, heard: 5 }];
	for (let index = 0; index < 20; index++) {
		steps.push({ planner: A_STARTING, name: null, heard: 5 });
	}
	expect(drawnThrough(CHANGE, steps, start)).toEqual([
		"Connecting to Box A",
		"Connecting to Box B",
	]);
});

test("without the switch, the same words withheld while the list is read made connecting go and come back", () => {
	// What the page did before: each withheld step drew nothing, so the dots went and came again.
	let start: PlannerMemory = { shown: plannerStatus(A_STARTING, "Box A"), gapped: false };
	expect(drawnThrough(undefined, [
		{ planner: A_STARTING, name: null, saving: true, heard: 5 },
		{ planner: A_STARTING, name: null, heard: 11 },
		{ planner: A_STARTING, name: "Box B", heard: 11 },
	], start)).toEqual(["Connecting to Box A", "quiet", "Connecting to Box B"]);
});

test("a switch says only what the server says once its word after the choice is known", () => {
	let after = switchedStatus(CHANGE, {
		status: undefined,
		saving: false,
		heard: 11,
		withheld: false,
	});
	expect(after).toEqual({ status: undefined, over: true });
	// A word from before the choice, or one still to be named, keeps it connecting.
	for (let facts of [{ heard: 9, withheld: false }, { heard: 11, withheld: true }]) {
		expect(switchedStatus(CHANGE, { status: undefined, saving: false, ...facts })).toEqual({
			status: { kind: "starting", text: "Connecting to Box B" },
			over: false,
		});
	}
	expect(switchedStatus(CHANGE, { status: undefined, saving: true, heard: 11, withheld: false }))
		.toMatchObject({ over: false });
});
