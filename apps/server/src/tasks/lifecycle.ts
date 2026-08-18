import { restoreRunVersion } from "./graphs";

import type { Graph, Run, Task } from "./graphs";

export type PullRequest = {
	url: string;
	state: "open" | "merged" | "closed";
};

type Working = {
	id: string;
	pullRequest?: PullRequest;
};

export type TaskProgress =
	| { id: string; state: "queued" }
	| (Working & { state: "in_progress" })
	| (Working & { state: "blocked"; blocker: string })
	| { id: string; state: "completed"; summary: string; pullRequest: PullRequest };

export type ProgressEvent =
	| { kind: "start"; taskId: string; idempotencyKey: string }
	| { kind: "block"; taskId: string; reason: string; idempotencyKey: string }
	| {
		kind: "report_pr";
		taskId: string;
		pullRequest: PullRequest;
		idempotencyKey: string;
	}
	| { kind: "complete"; taskId: string; summary: string; idempotencyKey: string }
	| { kind: "request_revision"; reason: string; idempotencyKey: string };

export type Progress = {
	tasks: TaskProgress[];
	events: ProgressEvent[];
};

export type ArchivedRun = {
	run: Run;
	events: ProgressEvent[];
	outcome: { kind: "revision_requested"; reason: string };
};

export type HistoricalRun = {
	run: Run;
	progress: Progress;
	outcome: ArchivedRun["outcome"];
};

export type Lifecycle = {
	events?: ProgressEvent[];
	history: ArchivedRun[];
};

export type LifecycleState = {
	graph: Graph;
	execution?: Run;
	lifecycle: Lifecycle;
};

export type LifecycleInput =
	| { kind: "start"; taskId: string; idempotencyKey: string }
	| { kind: "block"; taskId: string; reason: string; idempotencyKey: string }
	| {
		kind: "report_pr";
		taskId: string;
		url: string;
		state: PullRequest["state"];
		idempotencyKey: string;
	}
	| { kind: "complete"; taskId: string; summary: string; idempotencyKey: string }
	| { kind: "request_revision"; reason: string; idempotencyKey: string };

export type LifecycleResult =
	| { kind: "accepted" | "replayed"; state: LifecycleState }
	| { kind: "refused"; reason: string };

function copy<T>(value: T): T {
	return structuredClone(value);
}

function current(graph: Graph): Task[] | undefined {
	let version = graph.versions.at(-1);
	return version?.state === "locked" ? version.definition.tasks : undefined;
}

function initial(tasks: Task[]): Progress {
	return { tasks: tasks.map(task => ({ id: task.id, state: "queued" })), events: [] };
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
	let actual = Object.keys(value).sort();
	let expected = [...keys].sort();
	return actual.length === expected.length
		&& actual.every((key, index) => key === expected[index]);
}

function pullRequest(value: unknown): PullRequest | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let item = value as Record<string, unknown>;
	if (
		!exact(item, ["state", "url"])
		|| typeof item.url !== "string"
		|| !item.url.trim()
		|| (item.state !== "open" && item.state !== "merged" && item.state !== "closed")
	) return undefined;
	return { url: item.url, state: item.state };
}

function progressEvent(value: unknown): ProgressEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let item = value as Record<string, unknown>;
	if (typeof item.idempotencyKey !== "string" || !item.idempotencyKey.trim()) return undefined;
	let idempotencyKey = item.idempotencyKey;
	if (item.kind === "request_revision") {
		return exact(item, ["idempotencyKey", "kind", "reason"])
				&& typeof item.reason === "string" && item.reason.trim()
			? { kind: item.kind, reason: item.reason, idempotencyKey }
			: undefined;
	}
	if (typeof item.taskId !== "string" || !item.taskId.trim()) return undefined;
	let taskId = item.taskId;
	if (item.kind === "start" && exact(item, ["idempotencyKey", "kind", "taskId"])) {
		return { kind: item.kind, taskId, idempotencyKey };
	}
	if (
		item.kind === "block"
		&& exact(item, ["idempotencyKey", "kind", "reason", "taskId"])
		&& typeof item.reason === "string"
		&& item.reason.trim()
	) return { kind: item.kind, taskId, reason: item.reason, idempotencyKey };
	if (
		item.kind === "report_pr" && exact(item, ["idempotencyKey", "kind", "pullRequest", "taskId"])
	) {
		let restored = pullRequest(item.pullRequest);
		return restored
			? { kind: item.kind, taskId, pullRequest: restored, idempotencyKey }
			: undefined;
	}
	if (
		item.kind === "complete"
		&& exact(item, ["idempotencyKey", "kind", "summary", "taskId"])
		&& typeof item.summary === "string"
		&& item.summary.trim()
	) return { kind: item.kind, taskId, summary: item.summary, idempotencyKey };
	return undefined;
}

function inputFor(stored: Exclude<ProgressEvent, { kind: "request_revision" }>): Exclude<
	LifecycleInput,
	{ kind: "request_revision" }
> {
	return stored.kind === "report_pr"
		? {
			kind: stored.kind,
			taskId: stored.taskId,
			url: stored.pullRequest.url,
			state: stored.pullRequest.state,
			idempotencyKey: stored.idempotencyKey,
		}
		: stored;
}

function restoreEvents(value: unknown): ProgressEvent[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	let restored = value.map(progressEvent);
	return restored.some(event => !event) ? undefined : restored as ProgressEvent[];
}

function derive(
	tasks: Task[],
	run: Run,
	events: ProgressEvent[],
	revisionReason?: string,
): Progress | undefined {
	let revision = events.at(-1);
	if (revisionReason === undefined) {
		if (events.some(event => event.kind === "request_revision")) return undefined;
	} else if (
		revision?.kind !== "request_revision"
		|| revision.reason !== revisionReason
		|| events.slice(0, -1).some(event => event.kind === "request_revision")
	) return undefined;
	let work = revisionReason === undefined ? events : events.slice(0, -1);
	let progress = initial(tasks);
	for (let storedEvent of work) {
		if (storedEvent.kind === "request_revision") return undefined;
		let result = advance(progress, tasks, run, inputFor(storedEvent));
		if (result.kind === "refused") return undefined;
		progress = result.progress;
	}
	if (revisionReason !== undefined) progress.events.push(revision!);
	return progress;
}

function projectHistory(graph: Graph, history: ArchivedRun[]): HistoricalRun[] | undefined {
	let projected: HistoricalRun[] = [];
	let nextVersion = 0;
	for (let archived of history) {
		let progress: Progress | undefined;
		for (let index = nextVersion; index < graph.versions.length; index++) {
			let version = graph.versions[index]!;
			if (
				version.planRevision !== archived.run.planRevision
				|| version.revision !== archived.run.graphRevision
			) continue;
			progress = derive(
				version.definition.tasks,
				archived.run,
				archived.events,
				archived.outcome.reason,
			);
			if (progress) {
				nextVersion = index;
				break;
			}
		}
		if (!progress) return undefined;
		projected.push({ run: copy(archived.run), progress, outcome: copy(archived.outcome) });
	}
	return projected;
}

function restoreHistory(stored: unknown, graph: Graph): ArchivedRun[] | undefined {
	if (!Array.isArray(stored)) return undefined;
	let history: ArchivedRun[] = [];
	for (let value of stored) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		let item = value as Record<string, unknown>;
		if (!exact(item, ["events", "outcome", "run"])) return undefined;
		let run = restoreRunVersion(item.run, graph);
		let events = restoreEvents(item.events);
		let outcome = item.outcome;
		if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return undefined;
		let result = outcome as Record<string, unknown>;
		if (
			!run || !events
			|| !exact(result, ["kind", "reason"])
			|| result.kind !== "revision_requested"
			|| typeof result.reason !== "string"
			|| !result.reason.trim()
		) return undefined;
		history.push({
			run,
			events,
			outcome: { kind: "revision_requested", reason: result.reason },
		});
	}
	return projectHistory(graph, history) ? history : undefined;
}

/** Restore lifecycle data only when it describes this graph and claim exactly. */
export function restoreLifecycle(
	value: unknown,
	graph: Graph,
	execution: Run | undefined,
): Lifecycle | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let stored = value as Record<string, unknown>;
	let keys = stored.events === undefined ? ["history"] : ["events", "history"];
	if (!exact(stored, keys)) return undefined;
	let history = restoreHistory(stored.history, graph);
	if (!history) return undefined;
	let events = stored.events === undefined ? undefined : restoreEvents(stored.events);
	let tasks = execution && current(graph);
	if (events && (!tasks || !execution || !derive(tasks, execution, events))) return undefined;
	if (stored.events !== undefined && !events) return undefined;
	let all = [...(events ?? []), ...history.flatMap(item => item.events)];
	if (new Set(all.map(event => event.idempotencyKey)).size !== all.length) return undefined;
	return { ...(events ? { events } : {}), history };
}

function event(input: LifecycleInput): ProgressEvent {
	switch (input.kind) {
		case "start":
			return { ...input };
		case "block":
			return { ...input };
		case "report_pr":
			return {
				kind: input.kind,
				taskId: input.taskId,
				pullRequest: { url: input.url, state: input.state },
				idempotencyKey: input.idempotencyKey,
			};
		case "complete":
			return { ...input };
		case "request_revision":
			return { ...input };
	}
}

function same(stored: ProgressEvent, input: LifecycleInput): boolean {
	if (stored.kind !== input.kind || stored.idempotencyKey !== input.idempotencyKey) return false;
	switch (stored.kind) {
		case "start":
			return input.kind === "start" && stored.taskId === input.taskId;
		case "block":
			return input.kind === "block" && stored.taskId === input.taskId
				&& stored.reason === input.reason;
		case "report_pr":
			return input.kind === "report_pr" && stored.taskId === input.taskId
				&& stored.pullRequest.url === input.url && stored.pullRequest.state === input.state;
		case "complete":
			return input.kind === "complete" && stored.taskId === input.taskId
				&& stored.summary === input.summary;
		case "request_revision":
			return input.kind === "request_revision" && stored.reason === input.reason;
	}
}

function replay(state: LifecycleState, input: LifecycleInput): LifecycleResult | undefined {
	let events = [
		...(state.lifecycle.events ?? []),
		...state.lifecycle.history.flatMap(item => item.events),
	];
	let prior = events.find(event => event.idempotencyKey === input.idempotencyKey);
	return prior
		? same(prior, input)
			? { kind: "replayed", state: copy(state) }
			: { kind: "refused", reason: "idempotency-conflict" }
		: undefined;
}

function ownPullRequest(repository: string, url: string): boolean {
	let match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url);
	return match?.[1] === repository;
}

type WorkInput = Exclude<LifecycleInput, { kind: "request_revision" }>;

type AdvanceResult =
	| { kind: "accepted"; progress: Progress }
	| { kind: "refused"; reason: string };

function advance(progress: Progress, tasks: Task[], run: Run, input: WorkInput): AdvanceResult {
	let nextProgress = copy(progress);
	let index = nextProgress.tasks.findIndex(item => item.id === input.taskId);
	let task = tasks[index];
	let item = nextProgress.tasks[index];
	if (!task || !item) return { kind: "refused", reason: "task" };
	let next: TaskProgress;
	switch (input.kind) {
		case "start":
			if (item.state !== "queued" && item.state !== "blocked") {
				return { kind: "refused", reason: "task-state" };
			}
			if (
				task.dependsOn.some(id =>
					nextProgress.tasks.find(item => item.id === id)?.state !== "completed"
				)
			) {
				return { kind: "refused", reason: "dependency" };
			}
			next = {
				id: item.id,
				state: "in_progress",
				...(item.state === "blocked" && item.pullRequest
					? { pullRequest: item.pullRequest }
					: {}),
			};
			break;
		case "block":
			if (item.state !== "in_progress") return { kind: "refused", reason: "task-state" };
			if (!input.reason.trim()) return { kind: "refused", reason: "reason" };
			next = {
				id: item.id,
				state: "blocked",
				blocker: input.reason,
				...(item.pullRequest ? { pullRequest: item.pullRequest } : {}),
			};
			break;
		case "report_pr": {
			if (item.state === "queued") return { kind: "refused", reason: "task-state" };
			if (!ownPullRequest(run.repository, input.url)) {
				return { kind: "refused", reason: "repository" };
			}
			let pullRequest = { url: input.url, state: input.state };
			next = { ...item, pullRequest };
			break;
		}
		case "complete":
			if (item.state !== "in_progress") return { kind: "refused", reason: "task-state" };
			if (!item.pullRequest) return { kind: "refused", reason: "pull-request" };
			if (!input.summary.trim()) return { kind: "refused", reason: "summary" };
			next = {
				id: item.id,
				state: "completed",
				summary: input.summary,
				pullRequest: item.pullRequest,
			};
			break;
	}
	nextProgress.tasks[index] = next;
	nextProgress.events.push(event(input));
	return { kind: "accepted", progress: nextProgress };
}

/** Apply one lifecycle event without mutating the graph or claim identity. */
export function transition(state: LifecycleState, input: LifecycleInput): LifecycleResult {
	if (!input.idempotencyKey.trim()) {
		return { kind: "refused", reason: "idempotency-key" };
	}
	let prior = replay(state, input);
	if (prior) return prior;
	let tasks = current(state.graph);
	let run = state.execution;
	if (!tasks || !run) return { kind: "refused", reason: "inactive" };
	let progress = derive(tasks, run, state.lifecycle.events ?? []);
	if (!progress) return { kind: "refused", reason: "invalid-lifecycle" };

	if (input.kind === "request_revision") {
		if (!input.reason.trim()) return { kind: "refused", reason: "reason" };
		let events = [...progress.events, event(input)];
		let graph = copy(state.graph);
		let version = graph.versions.at(-1)!;
		graph.versions[graph.versions.length - 1] = { ...version, state: "approved" };
		return {
			kind: "accepted",
			state: {
				graph,
				execution: undefined,
				lifecycle: {
					history: [...state.lifecycle.history, {
						run: copy(run),
						events,
						outcome: { kind: "revision_requested", reason: input.reason },
					}],
				},
			},
		};
	}

	let advanced = advance(progress, tasks, run, input);
	if (advanced.kind === "refused") return advanced;
	return {
		kind: "accepted",
		state: {
			...state,
			lifecycle: { ...state.lifecycle, events: advanced.progress.events },
		},
	};
}

/** Project queued work before the first lifecycle event. */
export function progressFor(
	graph: Graph,
	lifecycle: Lifecycle,
	execution?: Run,
): Progress | undefined {
	let version = graph.versions.at(-1);
	if (!version || !execution) return undefined;
	let events = lifecycle.events ?? [];
	return events.length === 0
		? initial(version.definition.tasks)
		: derive(version.definition.tasks, execution, events);
}

/** Project archived event logs against the graph versions they implemented. */
export function historyFor(graph: Graph, lifecycle: Lifecycle): HistoricalRun[] {
	return copy(projectHistory(graph, lifecycle.history) ?? []);
}
