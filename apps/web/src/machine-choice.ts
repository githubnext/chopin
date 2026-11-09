import { useCallback, useEffect, useRef, useState } from "react";

import { machines as liveMachines, newestFirst, ownerHint } from "./machine-summary";
import { sameJson } from "./same-json";

import type { Machine, TeammateMachine } from "./machine-summary";
import type { Session } from "@chopin/protocol";

/**
 * A machine serving a document's repository, as the server lists it: one of the person's own, or
 * a teammate's that its owner shares and can push to the repository from.
 */
export type ChoosableMachine = {
	id: string;
	label: string;
	/** It has a live connection for this repository now. */
	connected: boolean;
	/** GitHub stopped accepting its authorization; it needs pairing again. Only the person's own say. */
	reauthorize?: boolean;
	/** When it was paired, in milliseconds: the order the menu lists machines in. */
	createdAt: number;
	lastSeenAt: number;
	version: string | null;
	hostname?: string | null;
	platform?: { os: string; arch: string } | null;
	agent?: { name: string; version?: string } | null;
	/** The background service runs it. */
	service: boolean;
	/** It can run Planners. */
	planner?: boolean;
	/** It has a Planner command, so it can run the Planner of a document it is chosen for. */
	runsPlanners?: boolean;
	/** A teammate's machine: its owner shares it, and only they change it. */
	teammate?: boolean;
	owner?: { login: string; avatarUrl: string };
};

/**
 * Who runs the document's Planner, as its chooser sees it: another account `held` (named), the
 * person's own account `attached` (on which of their machines, if one) or `disconnected` with
 * its work kept, the chosen machine's backend `starting`, or `none`.
 */
export type PlannerRunner = {
	state: "held" | "attached" | "disconnected" | "starting" | "none";
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
 * Whether a document offers the machine choice: its button left of Build plan. Once the person
 * has added a machine, connected or not, and whatever repositories its checkouts are of, or the
 * document lists a teammate's shared machine; before that the Machines page is the way to add one.
 */
export function showsMachineChoice(
	machines: readonly Pick<Machine, "id">[] | undefined,
	state?: MachineChoiceState,
): boolean {
	return !!machines?.length || !!state?.machines.some(machine => machine.teammate);
}

/** Why Build can't start: the chosen machine, the person's or a teammate's, is offline. Named. Automatic never is. */
export function offlineChoice(state: MachineChoiceState | undefined): string | undefined {
	let chosen = chosenMachine(state);
	return chosen && !chosen.connected ? `${chosen.label} is offline` : undefined;
}

/**
 * The name the Planner's status gives the machine it is starting on, or was running on when it
 * dropped: the document's own machine, the one its button names (the person's choice, else the one
 * Automatic uses now), and no other. Not another machine of the person's own, which a list read
 * before the choice changed may still describe; not a teammate's the document is not set to run
 * on, which is named by its owner's login instead; nor one that is not in the person's list at all.
 */
export function plannerRunsOn(state: MachineChoiceState | undefined): string | undefined {
	return plannerMachine(state)?.label;
}

/** The machine the list says the Planner is starting on or dropped from, whose ever it is. */
function plannerRunner(state: MachineChoiceState | undefined): ChoosableMachine | undefined {
	let planner = state?.planner;
	if (!planner?.machine || (planner.state !== "starting" && planner.state !== "disconnected")) {
		return undefined;
	}
	return state?.machines.find(value => value.id === planner.machine);
}

function plannerMachine(state: MachineChoiceState | undefined): ChoosableMachine | undefined {
	let machine = plannerRunner(state);
	return machine && shownMachine(state)?.id === machine.id ? machine : undefined;
}

/**
 * When the machine a disconnected Planner was on was last seen, as a contact's last seen is said,
 * while it is away. Not for one that is connected: it was seen just now, and only the Planner
 * dropped.
 */
export function plannerLastSeen(state: MachineChoiceState | undefined): string | undefined {
	let machine = state?.planner?.state === "disconnected" ? plannerMachine(state) : undefined;
	return machine && !machine.connected ? new Date(machine.lastSeenAt).toISOString() : undefined;
}

/**
 * What `plannerStatus` is told of the machine the Planner is on. A name, where `plannerRunsOn` has
 * one; undefined where the status says whose machine it is by login. `null` says nothing is said
 * yet: while the person's machines are loading; while the list is older than the socket's word
 * (`current` is false: it was read before the word came, so it describes the Planner as it was, and
 * may name a machine it has since left, or one the document no longer runs on); while the list
 * names a machine the document does not run on (a teammate's, or another of the person's own) for
 * a Planner the person's own account is the one starting or dropping; and while the list describes
 * another account's Planner than the page's socket does (its login, or the viewer's own where the
 * machine is theirs). In each the two disagree, and the list is what is out of date.
 */
export function plannerMachineName(
	state: MachineChoiceState | undefined,
	planner: Session.PlannerAttachment | undefined,
	viewer: string,
	loading: boolean,
	current: boolean,
): string | null | undefined {
	if (!state) return loading ? null : undefined;
	if (planner?.state !== "starting" && planner?.state !== "disconnected") return undefined;
	if (!current) return null;
	let name = plannerRunsOn(state);
	if (name !== undefined) {
		return (state.planner?.login ?? viewer).toLowerCase() === planner.login.toLowerCase()
			? name
			: null;
	}
	return plannerRunner(state) && planner.login.toLowerCase() === viewer.toLowerCase()
		? null
		: undefined;
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
	/** The login of a teammate's machine's owner, only where another machine has its name; else undefined. */
	owner?: string;
	machine: ChoosableMachine;
};

/**
 * The menu's rows, one per machine: Local ones first, then Cloud, each newest paired first,
 * the person's own and the teammates' shared ones sorted together, offline ones disabled.
 */
export function machineRows(state: MachineChoiceState): MachineRow[] {
	let shown = shownMachine(state);
	let rows = state.machines.toSorted(newestFirst).map(machine => {
		let owner = ownerHint(machine, state.machines);
		return {
			id: machine.id,
			label: machine.label,
			detail: STATE_WORDS[machineState(machine)],
			checked: shown?.id === machine.id,
			disabled: !machine.connected || !!machine.reauthorize,
			cloud: machine.service,
			...(owner ? { owner } : {}),
			machine,
		};
	});
	return [false, true].flatMap(cloud => rows.filter(row => row.cloud === cloud));
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

/**
 * What of the machines a document's choice depends on: which of the person's are paired and online,
 * and which teammates' shared machines are.
 */
export function presence(
	list: readonly Machine[] | undefined,
	teammates: readonly TeammateMachine[] = [],
): string | undefined {
	return list && [
		...list.map(machine => `${machine.id}:${machine.connected}:${machine.reauthorize}`),
		...teammates.map(machine => `${machine.id}:${machine.connected}:shared`),
	].sort().join(" ");
}

let readings = 0;

/**
 * A place in the one order that the words the page's socket says of the Planner and the reads of
 * the machine list share. A read that began before a word arrived describes the Planner as it was
 * and cannot say which machine the word is of; one that began after can.
 */
export function nextReading(): number {
	return ++readings;
}

/** What the hook holds: the choice as last read, and where that read began in the order of `nextReading`. */
export type Held = { state?: MachineChoiceState; read: number };

/**
 * What is held after a read that began at `began` answered `value`, the one answered before it
 * having begun at `previous`. An answer that repeats the held choice keeps the very same hold, so
 * the room that draws it renders nothing: the read's place in the order matters only when a number
 * was minted since the last read, a word of the socket's, which makes this read the first to begin
 * after it. Reads minted one after another have nothing between them, so skipping the move is
 * then exact, however many of them the hold has not followed.
 */
export function afterRead(
	held: Held,
	value: MachineChoiceState,
	began: number,
	previous: number,
): Held {
	if (!held.state || !sameJson(held.state, value)) return { state: value, read: began };
	return began === previous + 1 ? held : { ...held, read: began };
}

export type MachineChoice = {
	state?: MachineChoiceState;
	/** Where the read that produced `state` began in the order of `nextReading`; 0 before any. */
	read: number;
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

/** Share one of the signed-in person's machines with teammates, or stop; resolves with the result. */
export async function setShared(machine: string, shared: boolean): Promise<boolean> {
	let response = await fetch(`/api/connector/machines/${encodeURIComponent(machine)}/shared`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ shared }),
	});
	let value = await response.json();
	if (!response.ok) throw new Error(value.message ?? value.error ?? "Chopin couldn’t save that");
	return value.shared;
}

/**
 * The person's machine for a document, read on open, on focus and every 15 seconds while
 * visible, and again as soon as the page's live machine list, asked every few seconds while the
 * document is open, sees a machine go offline, come back or need pairing again. One instance
 * serves every machine button of the document, so they always agree.
 */
export function useMachineChoice(room: string, enabled: boolean): MachineChoice {
	let [{ state, read }, setHeld] = useState<Held>({ read: 0 });
	let [saving, setSaving] = useState(false);
	let [error, setError] = useState<string>();
	let generation = useRef(0);
	// Where the read answered last began; the hold follows it only when it says something new.
	let answeredAt = useRef(0);
	let refresh = useCallback(() => {
		if (!enabled || document.visibilityState === "hidden") return;
		let mine = ++generation.current;
		let began = nextReading();
		fetch(endpoint(room)).then(answer).then(
			value => {
				if (mine !== generation.current) return;
				let previous = answeredAt.current;
				answeredAt.current = began;
				setHeld(held => afterRead(held, value, began, previous));
			},
			() => {},
		);
	}, [room, enabled]);
	useEffect(() => {
		answeredAt.current = 0;
		setHeld({ read: 0 });
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
		let seen = presence(liveMachines.snapshot().machines, liveMachines.snapshot().teammates);
		let unwatch = liveMachines.watch(() => {
			let { machines, teammates } = liveMachines.snapshot();
			let now = presence(machines, teammates);
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
		let began = nextReading();
		setSaving(true);
		setError(undefined);
		// Shown at once; the server's answer replaces it.
		setHeld(held => held.state ? { ...held, state: { ...held.state, choice: machine } } : held);
		try {
			let value = await answer(
				await fetch(endpoint(room), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ machine }),
				}),
			);
			if (mine === generation.current) {
				answeredAt.current = began;
				setHeld({ state: value, read: began });
			}
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Chopin couldn’t save that choice");
			refresh();
		} finally {
			setSaving(false);
		}
	};
	return { state, read, saving, error, choose, refresh };
}
