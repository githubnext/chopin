import { useEffect, useState } from "react";

/** One of the signed-in person's paired machines, as `GET /api/connector/machines` lists it. */
export type Machine = {
	id: string;
	label: string;
	repositories: string[];
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
	/** The address it connected from, as Chopin saw it. */
	address: string | null;
	/** The background service runs it. */
	service: boolean;
	/** It runs Planners for documents too. */
	planner: boolean;
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

/**
 * The person's machines, fetched on mount and again whenever the window regains focus, so a
 * machine paired in another tab shows up on return. Undefined until loaded or after a failure.
 */
export function useMachineSummary(): MachineSummary | undefined {
	let [summary, setSummary] = useState<MachineSummary>();
	useEffect(() => {
		let abort = new AbortController();
		let load = () => {
			if (document.visibilityState === "hidden") return;
			listMachines(abort.signal).then(
				machines => setSummary(summarizeMachines(machines)),
				() => {
					if (!abort.signal.aborted) setSummary(undefined);
				},
			);
		};
		load();
		window.addEventListener("focus", load);
		document.addEventListener("visibilitychange", load);
		return () => {
			abort.abort();
			window.removeEventListener("focus", load);
			document.removeEventListener("visibilitychange", load);
		};
	}, []);
	return summary;
}
