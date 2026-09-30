import type {
	ExtensionAPI,
	ExtensionFactory,
	HostInput,
	WorkflowActivitySubscription,
	WorkflowRootActivity,
} from "@bastani/atomic";

/** Root workflow runs a Planner session owns: still live, or paused and resumable. */
export type PlannerRuns = { active: string[]; paused: string[] };

export type FullPlanner = {
	cwd: string;
	humanInput: HostInput;
	/** Latest known runs; absent until Atomic reports its workflow activity as ready. */
	runs?: PlannerRuns;
	/** Called with every change to `runs`. */
	onRuns?: (runs: PlannerRuns) => void;
	/** Runs a slash command in the live session without a model turn; set once the session exists. */
	command?: (text: string) => Promise<void>;
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

/** Working and blocked roots are live; an idle root is paused only when Atomic says so. */
export function classifyRuns(roots: Iterable<WorkflowRootActivity>): PlannerRuns {
	let runs: PlannerRuns = { active: [], paused: [] };
	for (let root of roots) {
		if (root.state === "working" || root.state === "blocked") runs.active.push(root.rootRunId);
		else if (root.reason === "paused") runs.paused.push(root.rootRunId);
	}
	return runs;
}

/**
 * Keeps `planner.runs` in step with the workflows this session owns, through
 * Atomic's public activity stream. Recovering or unavailable snapshots are
 * unknown rather than empty, so they leave the last known runs in place.
 */
export function workflowRuns(planner: FullPlanner): ExtensionFactory {
	return (atomic: ExtensionAPI): void => {
		let lease: WorkflowActivitySubscription | undefined;
		let roots = new Map<string, WorkflowRootActivity>();
		let publish = () => {
			planner.runs = classifyRuns(roots.values());
			planner.onRuns?.(planner.runs);
		};
		atomic.on("session_start", (_event, ctx) => {
			lease?.dispose();
			lease = ctx.observeWorkflowActivity(frame => {
				if (frame.kind === "snapshot") {
					if (frame.availability !== "ready") return;
					roots = new Map(frame.roots.map(root => [root.rootRunId, root]));
				} else if (frame.kind === "changed") roots.set(frame.root.rootRunId, frame.root);
				else roots.delete(frame.rootRunId);
				publish();
			});
		});
		atomic.on("session_shutdown", () => lease?.dispose());
	};
}
