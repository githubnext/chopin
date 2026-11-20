import type { Chat as Wire } from "@chopin/protocol";

/**
 * Root workflow runs a Planner session owns: still live, or paused and
 * resumable, plus what each run's card shows. Only a remote Planner's client
 * reports them.
 */
export type PlannerRuns = { active: string[]; paused: string[]; cards: Wire.Run[] };

/** What Chopin keeps of the workflow runs a Planner session's client reports. */
export type RunReports = {
	/** Latest known runs; absent until the client reports them. */
	runs?: PlannerRuns;
	/** Called with every change to `runs`. */
	onRuns?: (runs: PlannerRuns) => void;
	/** The root run that owns a run, as the client reported it. */
	rootOf?: (runId: string) => string;
	/** Woken on every change to `runs`. */
	waiters?: Set<() => void>;
};

/**
 * Resolves once the root run owning `runId` is not paused. A client leaves a
 * question open when its run pauses, so an answer given meanwhile is held here
 * until the run resumes, keeping the paused run fully stopped.
 */
export async function untilUnpaused(
	planner: Pick<RunReports, "runs" | "rootOf" | "waiters">,
	runId: string,
	signal: AbortSignal,
): Promise<void> {
	let paused = () => planner.runs?.paused.includes(planner.rootOf?.(runId) ?? runId) ?? false;
	while (paused() && !signal.aborted) {
		await new Promise<void>(resolve => {
			let wake = () => {
				planner.waiters?.delete(wake);
				signal.removeEventListener("abort", wake);
				resolve();
			};
			(planner.waiters ??= new Set()).add(wake);
			signal.addEventListener("abort", wake, { once: true });
		});
	}
}
