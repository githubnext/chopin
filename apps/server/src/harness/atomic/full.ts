import type { HostInput } from "@bastani/atomic";

export type FullPlanner = { cwd: string; humanInput: HostInput };
let planners = new Map<string, FullPlanner>();

/** Only a verified Planner session is registered; background workers are not. */
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
