import { useCallback, useEffect, useRef, useState } from "react";

import { machines as liveMachines } from "./machine-summary";

import type { Machine } from "./machine-summary";

/** One of the person's machines serving a document's repository, as the server lists it. */
export type ChoosableMachine = {
	id: string;
	label: string;
	/** It has a live connection for this repository now. */
	connected: boolean;
	/** GitHub stopped accepting its authorization; it needs pairing again. */
	reauthorize: boolean;
	lastSeenAt: number;
	version: string | null;
	hostname: string | null;
	platform: { os: string; arch: string } | null;
	agent: { name: string; version?: string } | null;
	/** The background service runs it. */
	service: boolean;
	/** It can run Planners. */
	planner: boolean;
	/** It has a Planner command, so it can run the Planner of a document it is chosen for. */
	runsPlanners?: boolean;
};

/**
 * Who runs the document's Planner, as its chooser sees it: another account `held` (named), the
 * person's own account `attached` (on which of their machines, if one), the chosen machine's
 * backend `starting`, or `none`.
 */
export type PlannerRunner = {
	state: "held" | "attached" | "starting" | "none";
	login: string | null;
	machine: string | null;
};

/** `GET /api/documents/:id/machine`: the person's own choice for the document, never anyone else's. */
export type MachineChoiceState = {
	/** The chosen machine's id; null for automatic. */
	choice: string | null;
	/** The person's favorite machine, which Automatic prefers; null for none. */
	favorite: string | null;
	/** The machine automatic would use now, when one is connected, and whether it is the favorite. */
	automatic: { id: string; label: string | null; favorite?: boolean } | null;
	machines: ChoosableMachine[];
	/** Who runs the document's Planner; null or absent when Chopin runs no Planners on machines. */
	planner?: PlannerRunner | null;
};

export type MachineState = "connected" | "offline" | "reauthorize";

export function machineState(machine: Pick<ChoosableMachine, "connected" | "reauthorize">) {
	return machine.reauthorize ? "reauthorize" : machine.connected ? "connected" : "offline";
}

/** The machine the person chose for the document, while it is still theirs. */
export function chosenMachine(state: MachineChoiceState | undefined) {
	return state?.choice ? state.machines.find(machine => machine.id === state.choice) : undefined;
}

/** The machine the document runs on: the person's choice, else the one Automatic uses now. */
export function shownMachine(state: MachineChoiceState | undefined) {
	let chosen = chosenMachine(state);
	if (chosen || !state?.automatic) return chosen;
	let id = state.automatic.id;
	return state.machines.find(machine => machine.id === id);
}

/** The machine button's accessible name and tooltip: which machine the document runs on. */
export function machineButtonLabel(state: MachineChoiceState | undefined): string {
	let name = state && (shownMachine(state)?.label ?? automaticLabel(state));
	return name ? `Runs on ${name}` : "Runs on: no machine connected";
}

function automaticLabel(state: MachineChoiceState) {
	let automatic = state.automatic;
	return automatic
		&& (automatic.label ?? state.machines.find(machine => machine.id === automatic.id)?.label);
}

/**
 * Whether a document offers the machine choice: its button left of Build plan. Only once the
 * person has added a machine, connected or not, and whatever repositories its checkouts are of;
 * before that the Machines page is the way to add one.
 */
export function showsMachineChoice(machines: readonly Pick<Machine, "id">[] | undefined): boolean {
	return !!machines?.length;
}

/** Why Build can't start: the chosen machine is offline, named. Automatic never is. */
export function offlineChoice(state: MachineChoiceState | undefined): string | undefined {
	let chosen = chosenMachine(state);
	return chosen && !chosen.connected ? `${chosen.label} is offline` : undefined;
}

/** The person's own machine that is starting the document's Planner, by name, when one is. */
export function plannerStartingOn(state: MachineChoiceState | undefined): string | undefined {
	let planner = state?.planner;
	if (planner?.state !== "starting" || !planner.machine) return undefined;
	return state?.machines.find(machine => machine.id === planner.machine)?.label;
}

const STATE_WORDS: Record<MachineState, string> = {
	connected: "Connected",
	offline: "Offline",
	reauthorize: "Needs reconnecting",
};

export type MachineRow = {
	id: string;
	label: string;
	/** Its state as one quiet word or two, as a screen reader hears it. */
	detail: string;
	/** The document's machine: the person's choice, else the one Automatic uses now. */
	checked: boolean;
	disabled: boolean;
	/** The machine the background service runs, which the menu lists under Cloud. */
	cloud: boolean;
	machine: ChoosableMachine;
};

/** The menu's rows, one per machine: Local ones first, then Cloud, offline ones disabled. */
export function machineRows(state: MachineChoiceState): MachineRow[] {
	let shown = shownMachine(state);
	let rows = state.machines.map(machine => ({
		id: machine.id,
		label: machine.label,
		detail: STATE_WORDS[machineState(machine)],
		checked: shown?.id === machine.id,
		disabled: !machine.connected || machine.reauthorize,
		cloud: machine.service,
		machine,
	}));
	return [...rows.filter(row => !row.cloud), ...rows.filter(row => row.cloud)];
}

function endpoint(room: string) {
	return `/api/documents/${encodeURIComponent(room)}/machine`;
}

async function answer(response: Response): Promise<MachineChoiceState> {
	let value = await response.json();
	if (!response.ok) throw new Error(value.message ?? value.error ?? "Machines are unavailable");
	return value;
}

/** How often the choice is read again while the document is open, so states stay current. */
const REFRESH_MS = 15_000;

/** What of the person's machines a document's choice depends on: which are paired and online. */
export function presence(list: readonly Machine[] | undefined): string | undefined {
	return list?.map(machine => `${machine.id}:${machine.connected}:${machine.reauthorize}`)
		.sort().join(" ");
}

export type MachineChoice = {
	state?: MachineChoiceState;
	/** A choice is being saved. */
	saving: boolean;
	/** Why the last choice was refused. */
	error?: string;
	choose: (machine: string | null) => Promise<void>;
	refresh: () => void;
};

/** Set or clear the signed-in person's favorite machine; resolves with the favorite after. */
export async function setFavorite(machine: string, favorite: boolean): Promise<string | null> {
	let response = await fetch(`/api/connector/machines/${encodeURIComponent(machine)}/favorite`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ favorite }),
	});
	let value = await response.json();
	if (!response.ok) throw new Error(value.message ?? value.error ?? "Chopin couldn’t save that");
	return value.favorite ?? null;
}

/**
 * The person's machine for a document, read on open, on focus and every 15 seconds while
 * visible, and again as soon as the page's live machine list, asked every few seconds while the
 * document is open, sees a machine go offline, come back or need pairing again. One instance
 * serves every machine button of the document, so they always agree.
 */
export function useMachineChoice(room: string, enabled: boolean): MachineChoice {
	let [state, setState] = useState<MachineChoiceState>();
	let [saving, setSaving] = useState(false);
	let [error, setError] = useState<string>();
	let generation = useRef(0);
	let refresh = useCallback(() => {
		if (!enabled || document.visibilityState === "hidden") return;
		let mine = ++generation.current;
		fetch(endpoint(room)).then(answer).then(
			value => mine === generation.current && setState(value),
			() => {},
		);
	}, [room, enabled]);
	useEffect(() => {
		setState(undefined);
		if (!enabled) return;
		refresh();
		let timer = window.setInterval(refresh, REFRESH_MS);
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			generation.current++;
			window.clearInterval(timer);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [refresh]);
	// A machine going offline or coming back changes what the buttons and Build plan show.
	useEffect(() => {
		if (!enabled) return;
		let seen = presence(liveMachines.snapshot().machines);
		let unwatch = liveMachines.watch(() => {
			let now = presence(liveMachines.snapshot().machines);
			if (now === undefined || now === seen) return;
			let changed = seen !== undefined;
			seen = now;
			if (changed) refresh();
		});
		let stop = liveMachines.poll();
		return () => {
			stop();
			unwatch();
		};
	}, [enabled, refresh]);
	let choose = async (machine: string | null) => {
		let mine = ++generation.current;
		setSaving(true);
		setError(undefined);
		// Shown at once; the server's answer replaces it.
		setState(current => current && { ...current, choice: machine });
		try {
			let value = await answer(
				await fetch(endpoint(room), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ machine }),
				}),
			);
			if (mine === generation.current) setState(value);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Chopin couldn’t save that choice");
			refresh();
		} finally {
			setSaving(false);
		}
	};
	return { state, saving, error, choose, refresh };
}
