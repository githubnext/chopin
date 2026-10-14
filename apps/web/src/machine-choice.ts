import { useCallback, useEffect, useRef, useState } from "react";

import { ago } from "./build-model";

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
};

export type MachineState = "connected" | "offline" | "reauthorize";

export function machineState(machine: Pick<ChoosableMachine, "connected" | "reauthorize">) {
	return machine.reauthorize ? "reauthorize" : machine.connected ? "connected" : "offline";
}

/** The machine the person chose for the document, while it is still theirs. */
export function chosenMachine(state: MachineChoiceState | undefined) {
	return state?.choice ? state.machines.find(machine => machine.id === state.choice) : undefined;
}

const STATE_WORDS: Record<MachineState, string> = {
	connected: "connected",
	offline: "offline",
	reauthorize: "needs pairing again",
};

/** The machine button's accessible name: which machine, and whether it can take work now. */
export function machineButtonLabel(state: MachineChoiceState | undefined): string {
	if (!state) return "Machine: Automatic";
	let chosen = chosenMachine(state);
	if (chosen) return `Machine: ${chosen.label}, ${STATE_WORDS[machineState(chosen)]}`;
	let using = automaticLabel(state);
	return `Machine: Automatic, ${using ? `uses ${using}` : "no machine connected"}`;
}

function automaticLabel(state: MachineChoiceState) {
	let automatic = state.automatic;
	return automatic
		&& (automatic.label ?? state.machines.find(machine => machine.id === automatic.id)?.label);
}

/** Why Build can't start: the chosen machine is offline, named. Automatic never is. */
export function offlineChoice(state: MachineChoiceState | undefined): string | undefined {
	let chosen = chosenMachine(state);
	return chosen && !chosen.connected ? `${chosen.label} is offline` : undefined;
}

const OS: Record<string, string> = { linux: "Linux", darwin: "macOS", win32: "Windows" };

/** A machine's one line under its name: its state, then its chopin release and system. */
export function machineDetail(machine: ChoosableMachine, now: number): string {
	let state = machineState(machine);
	if (state === "reauthorize") return "Needs pairing again";
	if (state === "offline") {
		let seen = ago(new Date(machine.lastSeenAt).toISOString(), now);
		return seen ? `Offline · last seen ${seen}` : "Offline";
	}
	return [
		"Connected",
		machine.version && `chopin ${machine.version}`,
		machine.platform && (OS[machine.platform.os] ?? machine.platform.os),
	].filter(Boolean).join(" · ");
}

export type MachineRow = {
	/** The machine's id, or null for Automatic. */
	id: string | null;
	label: string;
	/** Its second line as words, as a screen reader hears it. */
	detail: string;
	checked: boolean;
	disabled: boolean;
	/** It is the person's favorite machine; never Automatic. */
	favorite: boolean;
	/** Automatic's: the machine it uses now, and whether that is the favorite. */
	uses?: { label: string; favorite: boolean };
	/** Automatic's: why it is not using the favorite, as "build-box is offline". */
	note?: string;
	/** Absent for Automatic. */
	machine?: ChoosableMachine;
};

/**
 * The menu's rows: Automatic and what it uses now (saying when the favorite is offline), then each
 * machine, offline ones disabled, the favorite's row alone starred.
 */
export function machineRows(state: MachineChoiceState, now: number): MachineRow[] {
	let chosen = chosenMachine(state);
	let using = automaticLabel(state);
	let favorite = state.favorite
		? state.machines.find(machine => machine.id === state.favorite)
		: undefined;
	let uses = using ? { label: using, favorite: !!state.automatic?.favorite } : undefined;
	let note = favorite && !uses?.favorite && machineState(favorite) !== "connected"
		? `${favorite.label} is offline`
		: undefined;
	let detail = uses
		? `Uses ${uses.label} now${note ? ` · ${note}` : ""}`
		: "No machine connected now";
	return [
		{
			id: null,
			label: "Automatic",
			detail,
			checked: !chosen,
			disabled: false,
			favorite: false,
			...(uses ? { uses, note } : {}),
		},
		...state.machines.map(machine => ({
			id: machine.id,
			label: machine.label,
			detail: machineDetail(machine, now),
			checked: chosen?.id === machine.id,
			disabled: !machine.connected,
			favorite: machine.id === state.favorite,
			machine,
		})),
	];
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

export type MachineChoice = {
	state?: MachineChoiceState;
	/** A choice is being saved. */
	saving: boolean;
	/** Why the last choice was refused. */
	error?: string;
	choose: (machine: string | null) => Promise<void>;
	/** Set or clear the person's favorite machine; the document's choice stays as it is. */
	favor: (machine: string, favorite: boolean) => Promise<void>;
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
 * visible. One instance serves every machine button of the document, so they always agree.
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
	let favor = async (machine: string, favorite: boolean) => {
		let mine = ++generation.current;
		setError(undefined);
		// Starred at once; the server's list replaces it.
		setState(current =>
			current && {
				...current,
				favorite: favorite ? machine : current.favorite === machine ? null : current.favorite,
			}
		);
		try {
			await setFavorite(machine, favorite);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Chopin couldn’t save that");
		} finally {
			if (mine === generation.current) refresh();
		}
	};
	return { state, saving, error, choose, favor, refresh };
}
