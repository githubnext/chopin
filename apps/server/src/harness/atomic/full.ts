import type { HostInput } from "@bastani/atomic";

export type FullPlanner = {
	cwd: string;
	humanInput: HostInput;
	/** The tools Atomic offers the running turn, set before its first stream part. */
	activeTools?: readonly string[];
	/**
	 * An Atomic-run tool's own progress or end. HarnessAgent holds tool results until
	 * its model step ends, so this is how the chat sees them as they happen.
	 */
	toolReport?: (id: string, output: unknown, state: "running" | "done" | "failed") => void;
	/** Serialized Atomic `FileEntry[]` (`[header, ...entries]`) to restore before running a turn. */
	sessionEntries?: unknown[];
	/** Entry id to branch from (`SessionManager.branch`) before prompting; `null` resets to root. */
	branchLeafId?: string | null;
	/** Called as Atomic appends entries so fork points and session trees stay durable. */
	onSessionEntries?: (entries: unknown[], leafId: string | null) => void;
};

let planners = new Map<string, FullPlanner>();

/** Every Atomic Planner session is registered; background workers never are. */
export function registerFullPlanner(sessionId: string, planner: FullPlanner): () => void {
	if (planners.has(sessionId)) throw new Error("Atomic Planner session is already registered");
	planners.set(sessionId, planner);
	return () => {
		if (planners.get(sessionId) === planner) planners.delete(sessionId);
	};
}

export function fullPlanner(sessionId: string): FullPlanner | undefined {
	return planners.get(sessionId);
}
