import { useEffect, useSyncExternalStore } from "react";

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
	/** The background service runs it. */
	service: boolean;
	/** It runs Planners for documents too. */
	planner: boolean;
	/** The person's favorite machine, which Automatic prefers. */
	favorite: boolean;
};

export type MachineSummary = { paired: number; connected: number };

export async function listMachines(signal?: AbortSignal): Promise<Machine[]> {
	let response = await fetch("/api/connector/machines", { signal });
	let result = await response.json();
	if (!response.ok) throw new Error(result.error ?? "Could not load your machines");
	return result.machines;
}

export function summarizeMachines(machines: readonly Pick<Machine, "connected">[]): MachineSummary {
	return {
		paired: machines.length,
		connected: machines.filter(machine => machine.connected).length,
	};
}

/**
 * The Machines entry's accessible name. It repeats the visible paired count whenever that differs
 * from the connected one, so the name always contains what the entry shows.
 */
export function machinesLabel(summary: MachineSummary | undefined): string {
	if (!summary) return "Machines";
	let connected = summary.connected ? `${summary.connected} connected` : "none connected";
	return summary.paired && summary.paired !== summary.connected
		? `Machines, ${summary.paired} paired, ${connected}`
		: `Machines, ${connected}`;
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

/** How often the list is asked again while a document or the Machines page is in view. */
export const LIVE_MS = 3000;

export type LiveMachines = {
	/** Undefined until the first answer. */
	machines?: Machine[];
	/** The server's code for the last failed answer; empty after a good one. */
	error: string;
};

/**
 * One copy of the person's machine list for the whole page, so the sidebar's count, a document's
 * machine buttons and the Machines page agree. `watch` hears every answer. While anything `poll`s,
 * the list is asked again every `interval` ms the page is visible, so a machine going offline or
 * coming back shows within seconds; otherwise it is asked on `load` alone.
 */
export function machineFeed(
	list: (signal: AbortSignal) => Promise<Machine[]>,
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
				let machines = await list(mine.signal);
				if (mine.signal.aborted) return;
				set({ machines, error: "" });
			} catch (error) {
				if (mine.signal.aborted) return;
				set({ ...current, error: error instanceof Error ? error.message : "unavailable" });
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
		/** Change the list here at once, as when a machine is removed, before the server says. */
		update(change: (machines: Machine[]) => Machine[]) {
			if (current.machines) set({ ...current, machines: change(current.machines) });
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

/** How many machines are paired and connected, live; undefined until loaded or after a failure. */
export function useMachineSummary(): MachineSummary | undefined {
	let { machines: list, error } = useLiveMachines();
	return list && !error ? summarizeMachines(list) : undefined;
}
