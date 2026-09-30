import type {
	ExtensionAPI,
	ExtensionFactory,
	HostInput,
	WorkflowActivitySubscription,
	WorkflowLifecycleEvent,
	WorkflowRootActivity,
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
	/** Runs the session's own `workflow` tool without a model turn; set once the session exists. */
	control?: (params: WorkflowControl) => Promise<void>;
};
export type WorkflowControl = { action: "pause"; all: true } | { action: "resume"; runId: string };

let planners = new Map<string, FullPlanner>();

/** The text of a tool result, for errors. */
function resultText(content: readonly { type: string; text?: string }[]): string {
	return content.map(part => part.type === "text" ? part.text ?? "" : "").join("\n").trim();
}

/**
 * Runs one run-control action through the session's `workflow` tool with a real
 * tool context, so the outcome comes back as a result rather than a UI notice.
 */
export async function controlWorkflows(
	session: {
		getToolDefinition(
			name: string,
		): { execute: (...args: never[]) => Promise<unknown> } | undefined;
		extensionRunner: { createToolContext(id: string, signal: AbortSignal | undefined): unknown };
	},
	params: WorkflowControl,
): Promise<void> {
	let tool = session.getToolDefinition("workflow");
	if (!tool) throw new Error("The Planner session has no workflow tool.");
	let id = `chopin-${params.action}-${crypto.randomUUID()}`;
	let signal = AbortSignal.timeout(30_000);
	let execute = tool.execute as (
		id: string,
		params: WorkflowControl,
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<
		{ content?: { type: string; text?: string }[]; isError?: boolean; details?: unknown }
	>;
	let result = await execute(
		id,
		params,
		signal,
		undefined,
		session.extensionRunner.createToolContext(id, signal),
	);
	let text = resultText(result.content ?? []);
	let failed = result.isError === true
		|| /"ok"\s*:\s*false|"status"\s*:\s*"failed"/.test(text);
	if (failed) throw new Error(`workflow ${params.action} failed: ${text.slice(0, 500)}`);
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

/** Working and blocked roots are live; an idle root is paused only when Atomic says so. */
export function classifyRuns(roots: Iterable<WorkflowRootActivity>): Omit<PlannerRuns, "cards"> {
	let runs = { active: [] as string[], paused: [] as string[] };
	for (let root of roots) {
		if (root.state === "working" || root.state === "blocked") runs.active.push(root.rootRunId);
		else if (root.reason === "paused") runs.paused.push(root.rootRunId);
	}
	return runs;
}

type Card = Wire.Run & { stageIndex: Map<string, number>; prompts: Set<string> };

const ENDED: Record<string, Wire.Run["status"] | undefined> = {
	completed: "finished",
	skipped: "finished",
	failed: "failed",
	blocked: "failed",
	killed: "stopped",
	cancelled: "stopped",
};

/** Folds one lifecycle event into its root run's card. */
export function foldLifecycle(
	cards: Map<string, Card>,
	event: WorkflowLifecycleEvent,
	name?: string,
): void {
	let seconds = Math.floor(event.occurredAt / 1000);
	let card = cards.get(event.rootRunId);
	if (!card) {
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
		if (card.status === "finished" || card.status === "failed" || card.status === "stopped") {
			card.ended = seconds;
		} else delete card.ended;
	} else if (target.kind === "stage") {
		let key = `${target.runId}:${target.stageId}`;
		let index = card.stageIndex.get(key);
		if (index === undefined) {
			index = card.stages.length;
			card.stageIndex.set(key, index);
			card.stages.push({ id: key, name: target.stageName, status: target.status });
		}
		let stage = card.stages[index]!;
		stage.status = target.status;
		if (target.status === "running" && stage.started === undefined) stage.started = seconds;
		if (
			target.status === "completed" || target.status === "failed" || target.status === "skipped"
		) {
			stage.ended = seconds;
		}
	} else if (target.kind === "prompt") {
		if (target.status === "opened") card.prompts.add(target.promptId);
		else card.prompts.delete(target.promptId);
		card.waiting = card.prompts.size;
	}
}

/** The run cards to show, with the live/paused split from activity taking precedence over lifecycle. */
export function runCards(cards: Map<string, Card>, runs: Omit<PlannerRuns, "cards">): Wire.Run[] {
	return [...cards.values()].map(({ stageIndex: _index, prompts: _prompts, ...card }) => {
		let status: Wire.Run["status"] = runs.paused.includes(card.id)
			? "paused"
			: runs.active.includes(card.id)
			? card.waiting > 0 ? "waiting" : "running"
			: card.status === "running" || card.status === "waiting"
			? "finished"
			: card.status;
		return { ...card, status, stages: card.stages.map(stage => ({ ...stage })) };
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
		let ready = false;
		let publish = () => {
			if (!ready) return;
			let split = classifyRuns(roots.values());
			for (let id of cards.keys()) {
				if (!split.active.includes(id) && !split.paused.includes(id) && !roots.has(id)) {
					let card = cards.get(id)!;
					if (card.status === "running" || card.status === "waiting") card.status = "finished";
				}
			}
			planner.runs = { ...split, cards: runCards(cards, split) };
			planner.onRuns?.(planner.runs);
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
			foldLifecycle(cards, event, names.get(event.rootRunId));
			publish();
		});
		atomic.on("session_shutdown", () => lease?.dispose());
	};
}
