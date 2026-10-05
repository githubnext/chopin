import type {
	ExtensionAPI,
	ExtensionFactory,
	HostInput,
	SessionWorkflows,
	WorkflowActivitySubscription,
	WorkflowLifecycleEvent,
	WorkflowRootActivity,
	WorkflowToolNodeStatus,
} from "@bastani/atomic";
import type { Chat as Wire } from "@chopin/protocol";

/**
 * Root workflow runs a Planner session owns: still live, or paused and
 * resumable, plus what each run's card shows.
 */
export type PlannerRuns = { active: string[]; paused: string[]; cards: Wire.Run[] };

export type FullPlanner = {
	cwd: string;
	humanInput: HostInput;
	/** Latest known runs; absent until Atomic reports its workflow activity as ready. */
	runs?: PlannerRuns;
	/** Called with every change to `runs`. */
	onRuns?: (runs: PlannerRuns) => void;
	/** The live session's run control; set once the session exists. */
	workflows?: SessionWorkflows;
	/** The root run that owns a run, as learned from lifecycle events. */
	rootOf?: (runId: string) => string;
	/** Woken on every change to `runs`. */
	waiters?: Set<() => void>;
	/** The tools Atomic offers the running turn, set before its first stream part. */
	activeTools?: readonly string[];
	/**
	 * An Atomic-run tool's own progress or end. HarnessAgent holds tool results until
	 * its model step ends, so this is how the chat sees them as they happen.
	 */
	toolReport?: (id: string, output: unknown, state: "running" | "done" | "failed") => void;
};

let planners = new Map<string, FullPlanner>();

/** Pauses every run the session owns. A run whose stage waits on a question counts as paused. */
export async function pauseOwnedRuns(workflows: SessionWorkflows): Promise<void> {
	let outcome = await workflows.pause({ all: true });
	if (outcome.status === "partial") {
		let still = (outcome.failedRuns ?? []).map(run => `${run.runId}: ${run.message}`).join("; ");
		throw new Error(`Some workflow runs are still active: ${still}`);
	}
}

/** Resumes every paused run the session owns. */
export async function resumeOwnedRuns(workflows: SessionWorkflows): Promise<void> {
	for (let run of await workflows.listRuns({ status: "paused" })) await workflows.resume(run.runId);
}

/**
 * Resolves once the root run owning `runId` is not paused. Atomic leaves a
 * question open when its run pauses, so an answer given meanwhile is held here
 * until the run resumes, keeping the paused run fully stopped.
 */
export async function untilUnpaused(
	planner: FullPlanner,
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

/**
 * A root Atomic reports as paused is paused; one whose run has ended, as told
 * by its lifecycle events, is neither; any other root is live. Activity alone
 * cannot say a run ended: a root is idle and quiescent whenever nothing is
 * counted as executing, which also happens between steps of a live run.
 */
export function classifyRuns(
	roots: Iterable<WorkflowRootActivity>,
	ended: ReadonlySet<string> = new Set(),
): Omit<PlannerRuns, "cards"> {
	let runs = { active: [] as string[], paused: [] as string[] };
	for (let root of roots) {
		if (root.reason === "paused") runs.paused.push(root.rootRunId);
		else if (!ended.has(root.rootRunId)) runs.active.push(root.rootRunId);
	}
	return runs;
}

/** Stages kept per run; earlier ones are counted, not listed. */
const STORED_STAGES = 12;

type Card = Wire.Run & { stageIndex: Map<string, number>; prompts: Set<string> };

const ENDED: Record<string, Wire.Run["status"] | undefined> = {
	completed: "finished",
	skipped: "finished",
	failed: "failed",
	blocked: "blocked",
	killed: "stopped",
	cancelled: "stopped",
};

/** A `ctx.tool` step shown with the stage statuses it corresponds to. */
const TOOL_STEP: Record<WorkflowToolNodeStatus, Wire.RunStage["status"]> = {
	pending: "pending",
	running: "running",
	completed: "completed",
	cached: "completed",
	failed: "failed",
	cancelled: "skipped",
};

/** Records one stage or tool step, in the order the run first reached it. */
function foldStep(
	card: Card,
	key: string,
	name: string,
	status: Wire.RunStage["status"],
	seconds: number,
	kind?: "tool",
): void {
	let index = card.stageIndex.get(key);
	if (index === undefined) {
		index = card.stages.length;
		card.stageIndex.set(key, index);
		card.stages.push({ id: key, name, status, ...(kind ? { kind } : {}) });
	}
	let stage = card.stages[index]!;
	stage.status = status;
	if (status === "running" && stage.started === undefined) stage.started = seconds;
	if (status === "completed" || status === "failed" || status === "skipped") stage.ended = seconds;
}

/** Folds one lifecycle event into its root run's card. */
export function foldLifecycle(
	cards: Map<string, Card>,
	event: WorkflowLifecycleEvent,
	name?: string,
): void {
	let seconds = Math.floor(event.occurredAt / 1000);
	let card = cards.get(event.rootRunId);
	if (!card) {
		for (let [id, other] of cards) if (other.ended !== undefined) cards.delete(id);
		card = {
			id: event.rootRunId,
			name: name ?? "workflow",
			status: "running",
			started: seconds,
			updated: seconds,
			stages: [],
			waiting: 0,
			stageIndex: new Map(),
			prompts: new Set(),
		};
		cards.set(event.rootRunId, card);
	}
	if (name) card.name = name;
	card.updated = Math.max(card.updated, seconds);
	let target = event.target;
	if (target.kind === "run" && target.runId === event.rootRunId) {
		card.status = ENDED[target.status] ?? (target.status === "paused" ? "paused" : "running");
		if (
			card.status === "finished" || card.status === "blocked" || card.status === "failed"
			|| card.status === "stopped"
		) {
			card.ended = seconds;
		} else delete card.ended;
	} else if (target.kind === "stage") {
		foldStep(card, `${target.runId}:${target.stageId}`, target.stageName, target.status, seconds);
	} else if (target.kind === "tool") {
		foldStep(
			card,
			`${target.runId}:${target.toolNodeId}`,
			target.toolName,
			TOOL_STEP[target.status],
			seconds,
			"tool",
		);
	} else if (target.kind === "prompt") {
		if (target.status === "opened") card.prompts.add(target.promptId);
		else card.prompts.delete(target.promptId);
		card.waiting = card.prompts.size;
	}
}

/** The run cards to show, with the live/paused split from activity taking precedence over lifecycle. */
export function runCards(cards: Map<string, Card>, runs: Omit<PlannerRuns, "cards">): Wire.Run[] {
	return [...cards.values()].map(({ stageIndex: _index, prompts: _prompts, ...card }) => {
		let waiting = Math.max(
			card.waiting,
			card.stages.filter(stage => stage.status === "awaiting_input").length,
		);
		let status: Wire.Run["status"] = runs.paused.includes(card.id)
			? "paused"
			: runs.active.includes(card.id)
			? waiting > 0 ? "waiting" : "running"
			: card.status === "running" || card.status === "waiting"
			? "finished"
			: card.status;
		let earlierStages = Math.max(0, card.stages.length - STORED_STAGES);
		return {
			...card,
			status,
			waiting,
			stages: card.stages.slice(earlierStages).map(stage => ({ ...stage })),
			...(earlierStages ? { earlierStages } : {}),
		};
	});
}

/** The workflow run id reported in a `workflow` tool result, when the call started one. */
function launchedRunId(content: readonly { type: string; text?: string }[]): string | undefined {
	let text = content.map(part => part.type === "text" ? part.text ?? "" : "").join("\n");
	return /"runId"\s*:\s*"([0-9a-f-]{36})"/.exec(text)?.[1];
}

/**
 * Keeps `planner.runs` in step with the workflows this session owns, through
 * Atomic's public activity stream and lifecycle hooks. Recovering or
 * unavailable snapshots are unknown rather than empty, so they leave the last
 * known runs in place.
 */
export function workflowRuns(planner: FullPlanner): ExtensionFactory {
	return (atomic: ExtensionAPI): void => {
		let lease: WorkflowActivitySubscription | undefined;
		let roots = new Map<string, WorkflowRootActivity>();
		let cards = new Map<string, Card>();
		let names = new Map<string, string>();
		let parents = new Map<string, string>();
		let seen = new Set<string>();
		planner.rootOf = runId => parents.get(runId) ?? runId;
		let ready = false;
		let publish = () => {
			if (!ready) return;
			for (let [id, card] of cards) {
				if (seen.has(id) && !roots.has(id) && card.ended === undefined) {
					card.status = "finished";
					card.ended = card.updated;
				}
			}
			let ended = new Set(
				[...cards.values()].filter(card => card.ended !== undefined).map(card => card.id),
			);
			let split = classifyRuns(roots.values(), ended);
			planner.runs = { ...split, cards: runCards(cards, split) };
			planner.onRuns?.(planner.runs);
			for (let wake of planner.waiters ?? []) wake();
		};
		atomic.on("session_start", (_event, ctx) => {
			lease?.dispose();
			lease = ctx.observeWorkflowActivity(frame => {
				if (frame.kind === "snapshot") {
					if (frame.availability !== "ready") return;
					ready = true;
					roots = new Map(frame.roots.map(root => [root.rootRunId, root]));
				} else if (frame.kind === "changed") roots.set(frame.root.rootRunId, frame.root);
				else roots.delete(frame.rootRunId);
				for (let id of roots.keys()) seen.add(id);
				publish();
			});
		});
		atomic.on("tool_result", event => {
			if (event.toolName !== "workflow" || event.input.action !== "run") return;
			let runId = launchedRunId(event.content);
			let name = typeof event.input.workflow === "string" ? event.input.workflow : undefined;
			if (!runId || !name) return;
			names.set(runId, name);
			let card = cards.get(runId);
			if (card) {
				card.name = name;
				publish();
			}
		});
		atomic.on("workflow_lifecycle", event => {
			if (event.target.kind !== "prompt") parents.set(event.target.runId, event.rootRunId);
			foldLifecycle(cards, event, names.get(event.rootRunId));
			publish();
		});
		atomic.on("session_shutdown", () => lease?.dispose());
	};
}
