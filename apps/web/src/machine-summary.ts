import { useEffect, useSyncExternalStore } from "react";
import type { SandboxReport } from "@chopin/protocol/connector";
import { sameJson } from "./same-json";

/** One of the signed-in person's paired machines, as `GET /api/connector/machines` lists it. */
export type Machine = {
	id: string;
	label: string;
	autoRun: boolean;
	createdAt: number;
	lastSeenAt: number;
	connected: boolean;
	/** GitHub stopped accepting the machine's authorization; it needs pairing again. */
	reauthorize: boolean;
	/** The chopin release it runs, known only while it is connected with a release build. */
	version: string | null;
	/** What its newest connection said about it; null when it said nothing or isn't connected. */
	hostname: string | null;
	platform: { os: string; arch: string } | null;
	agent: { name: string; version?: string } | null;
	/** Whether its agents run in the system's process sandbox; null when it said nothing. */
	sandbox: SandboxReport | null;
	/** The background service runs it. */
	service: boolean;
	/** It runs Planners for documents too. */
	planner: boolean;
	/** The person's favorite machine, which Automatic prefers. */
	favorite: boolean;
	/** Teammates' documents may run their Planner here when they have no machine of their own. */
	shared: boolean;
	/** Teammates' documents it still runs the Planner of after sharing stopped, until their work finishes. */
	finishing?: number;
};

/**
 * A teammate's machine shared with the person, as `GET /api/connector/machines` lists it: read-only,
 * so without what only its owner sees or changes.
 */
export type TeammateMachine = {
	id: string;
	label: string;
	teammate: true;
	owner: { login: string; avatarUrl: string };
	/** The repositories it serves the person in: ones its owner and the person can both push to. */
	repositories: string[];
	connected: boolean;
	/** When it was paired, in milliseconds: the order machines are listed in, as the person's own are. */
	createdAt: number;
	lastSeenAt: number;
	/** The chopin release it runs, known only while it is connected with a release build. */
	version: string | null;
	/** The background service runs it. */
	service: boolean;
	/** The person's own favorite, which Automatic prefers; no one else sees whose. */
	favorite: boolean;
};

/** How many machines the person can run work on, their own and teammates' shared ones, and how many are connected now. */
export type MachineSummary = { total: number; connected: number };

export async function listMachines(
	signal?: AbortSignal,
): Promise<Array<Machine | TeammateMachine>> {
	let response = await fetch("/api/connector/machines", { signal });
	let result = await response.json();
	if (!response.ok) throw new Error(result.error ?? "Could not load your machines");
	return result.machines;
}

export function summarizeMachines(machines: readonly Pick<Machine, "connected">[]): MachineSummary {
	return {
		total: machines.length,
		connected: machines.filter(machine => machine.connected).length,
	};
}

/**
 * The order every list of machines is in: newest paired first, then by id, as the server lists
 * the person's own machines (`created_at DESC, id`). Their own and teammates' use this one.
 */
export function newestFirst(
	a: { id: string; createdAt: number },
	b: { id: string; createdAt: number },
): number {
	return b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Everything the person can run work on, as one list: their own machines and the teammates'
 * shared with them, sorted together, newest first; undefined until the first answer.
 */
export function allMachines(
	{ machines, teammates }: Pick<LiveMachines, "machines" | "teammates">,
): Array<Machine | TeammateMachine> | undefined {
	return machines && [...machines, ...teammates ?? []].sort(newestFirst);
}

/** The summary of everything in a live list: the person's own machines and the teammates' machines shared with them. */
export function summarizeLive(live: LiveMachines): MachineSummary | undefined {
	let all = allMachines(live);
	return all && summarizeMachines(all);
}

/**
 * The login of a teammate's machine's owner, where another machine in the list has the same
 * name, to tell them apart; undefined for the person's own and for a name that is alone.
 */
export function ownerHint(
	machine: { label: string; owner?: { login: string } },
	all: readonly { label: string }[],
): string | undefined {
	let name = machine.label.toLowerCase();
	return machine.owner && all.filter(other => other.label.toLowerCase() === name).length > 1
		? machine.owner.login
		: undefined;
}

/**
 * The Machines entry's accessible name. It repeats the visible total whenever that differs from
 * the connected count, so the name always contains what the entry shows.
 */
export function machinesLabel(summary: MachineSummary | undefined): string {
	if (!summary) return "Machines";
	if (summary.total && summary.total !== summary.connected) {
		return `Machines, ${summary.connected || "none"} of ${summary.total} connected`;
	}
	return `Machines, ${summary.connected ? `${summary.connected} connected` : "none connected"}`;
}

/** Whether a machine's chopin release is older than the one this server recommends. */
export function updateAvailable(version: string | null, recommended: string | null): boolean {
	if (!version || !recommended) return false;
	let parse = (value: string) => {
		let [release = "", prerelease] = value.split(/[-+]/, 2);
		return {
			parts: release.split(".").map(Number),
			prerelease: value.includes("-") && !!prerelease,
		};
	};
	let current = parse(version);
	let wanted = parse(recommended);
	for (let index = 0; index < 3; index++) {
		let difference = (current.parts[index] ?? 0) - (wanted.parts[index] ?? 0);
		if (difference) return difference < 0;
	}
	return current.prerelease && !wanted.prerelease;
}

export function isTeammate(machine: Machine | TeammateMachine): machine is TeammateMachine {
	return "teammate" in machine && machine.teammate === true;
}

function isOwn(machine: Machine | TeammateMachine): machine is Machine {
	return !isTeammate(machine);
}

/** How often the list is asked again while a document or the Machines page is in view. */
export const LIVE_MS = 3000;

export type LiveMachines = {
	/** The person's own machines; undefined until the first answer. */
	machines?: Machine[];
	/** Teammates' machines shared with them; undefined until the first answer. */
	teammates?: TeammateMachine[];
	/** The server's code for the last failed answer; empty after a good one. */
	error: string;
};

/**
 * One copy of the person's machine list, and the teammates' machines shared with them, for the
 * whole page, so the sidebar's count, a document's machine buttons and the Machines page agree.
 * `watch` hears each answer that says something new: one that repeats what the page holds is
 * dropped, so a poll every few seconds renders nothing until a machine changes. While anything
 * `poll`s, the list is asked again every `interval` ms the page is visible, so a machine going
 * offline or coming back shows within seconds; otherwise it is asked on `load` alone.
 */
export function machineFeed(
	list: (signal: AbortSignal) => Promise<Array<Machine | TeammateMachine>>,
	{ interval = LIVE_MS, visible = () => true }: { interval?: number; visible?: () => boolean } = {},
) {
	let current: LiveMachines = { error: "" };
	let listeners = new Set<() => void>();
	let pollers = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: AbortController | undefined;
	let set = (next: LiveMachines) => {
		current = next;
		for (let listener of listeners) listener();
	};
	let schedule = () => {
		clearTimeout(timer);
		timer = pollers ? setTimeout(() => void load(), interval) : undefined;
	};
	let load = async () => {
		clearTimeout(timer);
		if (visible()) {
			abort?.abort();
			let mine = abort = new AbortController();
			try {
				let listed = await list(mine.signal);
				if (mine.signal.aborted) return;
				let answer = {
					machines: listed.filter(isOwn),
					teammates: listed.filter(isTeammate),
					error: "",
				};
				if (!sameJson(current, answer)) set(answer);
			} catch (error) {
				if (mine.signal.aborted) return;
				let message = error instanceof Error ? error.message : "unavailable";
				if (current.error !== message) set({ ...current, error: message });
			}
		}
		schedule();
	};
	return {
		snapshot: () => current,
		/** Hear each answer; the returned function stops. */
		watch(listener: () => void) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		/** Ask now, then again every few seconds until the returned function stops. */
		poll() {
			pollers++;
			void load();
			return () => {
				if (--pollers) return;
				clearTimeout(timer);
				timer = undefined;
			};
		},
		load,
		/** Change the person's own list here at once, as when a machine is removed, before the server says. */
		update(change: (machines: Machine[]) => Machine[]) {
			if (current.machines) set({ ...current, machines: change(current.machines) });
		},
		/** Mark the person's favorite, one of the machines in either list or none, before the server says. */
		favor(chosen: string | null) {
			if (!current.machines) return;
			set({
				...current,
				machines: current.machines.map(machine => ({
					...machine,
					favorite: machine.id === chosen,
				})),
				teammates: current.teammates?.map(machine => ({
					...machine,
					favorite: machine.id === chosen,
				})),
			});
		},
	};
}

export const machines = machineFeed(listMachines, {
	visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
});

/**
 * The person's machine list as the page last heard it. With `poll`, it is asked again every few
 * seconds while the page is visible; it is also asked on mount and whenever the window regains
 * focus or becomes visible, so a machine paired in another tab shows up on return.
 */
export function useLiveMachines(poll = false): LiveMachines {
	let value = useSyncExternalStore(machines.watch, machines.snapshot, machines.snapshot);
	useEffect(() => {
		let load = () => void machines.load();
		let stop = poll ? machines.poll() : (load(), undefined);
		window.addEventListener("focus", load);
		document.addEventListener("visibilitychange", load);
		return () => {
			stop?.();
			window.removeEventListener("focus", load);
			document.removeEventListener("visibilitychange", load);
		};
	}, [poll]);
	return value;
}

/** How many machines the person can run work on, their own and teammates' shared ones, and how many are connected, live; undefined until loaded or after a failure. */
export function useMachineSummary(): MachineSummary | undefined {
	let live = useLiveMachines();
	return live.error ? undefined : summarizeLive(live);
}
