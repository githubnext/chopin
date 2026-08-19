import { matches, restoreRunVersion } from "./graphs";

import type { Plan as WirePlan } from "@chopin/protocol";
import type { Graph, Run, Task, Version } from "./graphs";

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

export type VerificationEvidence = { taskId: string; evidence: string[] };
export type VerificationReport = {
	passed: boolean;
	summary: string;
	reviewerMethod: string;
	evidence: VerificationEvidence[];
	tasksNeedingWork: string[];
};

type Command =
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
	| ({ kind: "report_verification"; idempotencyKey: string } & VerificationReport)
	| { kind: "request_revision"; reason: string; idempotencyKey: string };

export type ProgressEvent = Command;

export type Progress = {
	tasks: TaskProgress[];
	events: ProgressEvent[];
	verification?: VerificationReport;
};

export type ArchivedRun = { run: Run; events: ProgressEvent[] };
export type HistoricalRun = {
	run: Run;
	progress: Progress;
	outcome:
		| { kind: "revision_requested"; reason: string }
		| { kind: "implemented" }
		| { kind: "delivered" };
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

export type ImplementationLifecycle = Pick<
	WirePlan.Lifecycle,
	"execution" | "activity" | "history"
>;

export type LifecycleInput = Command & { runId: string };

export type LifecycleResult =
	| { kind: "accepted" | "replayed"; state: LifecycleState }
	| { kind: "refused"; reason: string };

export type ClaimEligibility =
	| { ok: true }
	| { ok: false; reason: "already-verified" | "run" };

type DerivedRun =
	| { phase: "active"; progress: Progress }
	| { phase: "revision_requested"; progress: Progress; reason: string }
	| { phase: "implemented" | "delivered"; progress: Progress };

type ReducerContext = { tasks: Task[]; run: Run };
type ReducerProgress = { tasks: TaskProgress[]; verification?: VerificationReport };
type ReducerState =
	| { phase: "active"; context: ReducerContext; progress: ReducerProgress }
	| {
		phase: "revision_requested";
		context: ReducerContext;
		progress: ReducerProgress;
		reason: string;
	}
	| {
		phase: "implemented" | "delivered";
		context: ReducerContext;
		progress: ReducerProgress;
	};
type Reduction =
	| { kind: "accepted"; state: ReducerState }
	| { kind: "refused"; reason: string };

function copy<T>(value: T): T {
	return structuredClone(value);
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
	let actual = Object.keys(value).sort();
	let expected = [...keys].sort();
	return actual.length === expected.length
		&& actual.every((key, index) => key === expected[index]);
}

function text(value: unknown): value is string {
	return typeof value === "string" && Boolean(value.trim());
}

function pullRequestState(value: unknown): value is PullRequest["state"] {
	return value === "open" || value === "merged" || value === "closed";
}

function ownPullRequest(repository: string, url: string): boolean {
	let match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url);
	return match?.[1] === repository;
}

function versionFor(graph: Graph, run: Run): Version | undefined {
	return graph.versions.find(version => matches(run, version));
}

function activeVersion(graph: Graph, run: Run): Version | undefined {
	let version = graph.versions.at(-1);
	return version?.state === "locked" && matches(run, version) ? version : undefined;
}

function initial(tasks: Task[], run: Run): ReducerState {
	return {
		phase: "active",
		context: { tasks, run },
		progress: { tasks: tasks.map(task => ({ id: task.id, state: "queued" })) },
	};
}

function reportFrom(value: VerificationReport): VerificationReport {
	return {
		passed: value.passed,
		summary: value.summary,
		reviewerMethod: value.reviewerMethod,
		evidence: copy(value.evidence),
		tasksNeedingWork: copy(value.tasksNeedingWork),
	};
}

function validReport(report: VerificationReport, tasks: Task[]): boolean {
	if (
		typeof report.passed !== "boolean"
		|| !text(report.summary)
		|| !text(report.reviewerMethod)
		|| !Array.isArray(report.evidence)
		|| !Array.isArray(report.tasksNeedingWork)
	) return false;
	let taskIds = new Set(tasks.map(task => task.id));
	let evidenceIds = new Set<string>();
	for (let entry of report.evidence) {
		if (
			!entry || typeof entry !== "object" || Array.isArray(entry)
			|| !exact(entry as unknown as Record<string, unknown>, ["evidence", "taskId"])
			|| !text(entry.taskId)
			|| !taskIds.has(entry.taskId)
			|| evidenceIds.has(entry.taskId)
			|| !Array.isArray(entry.evidence)
			|| entry.evidence.length === 0
			|| entry.evidence.some(item => !text(item))
		) return false;
		evidenceIds.add(entry.taskId);
	}
	if (evidenceIds.size !== taskIds.size) return false;
	if (report.tasksNeedingWork.some(id => !text(id) || !taskIds.has(id))) return false;
	let work = new Set(report.tasksNeedingWork);
	if (work.size !== report.tasksNeedingWork.length) return false;
	return report.passed ? work.size === 0 : work.size > 0;
}

function deliveryPhase(tasks: TaskProgress[]): "implemented" | "delivered" {
	let requests = new Map<string, PullRequest["state"]>();
	for (let task of tasks) {
		if (task.state !== "completed") return "implemented";
		requests.set(task.pullRequest.url, task.pullRequest.state);
	}
	return [...requests.values()].every(state => state === "merged")
		? "delivered"
		: "implemented";
}

function accepted(state: ReducerState): Reduction {
	return { kind: "accepted", state };
}

function refused(reason: string): Reduction {
	return { kind: "refused", reason };
}

function reduceEvent(state: ReducerState, stored: ProgressEvent): Reduction {
	let { run, tasks } = state.context;
	let progress = state.progress;
	if (state.phase === "revision_requested") return refused("terminal");
	if (state.phase === "implemented" || state.phase === "delivered") {
		if (stored.kind !== "report_pr") return refused("terminal");
		let addressed = progress.tasks.find(task => task.id === stored.taskId);
		if (
			!addressed || addressed.state !== "completed"
			|| addressed.pullRequest.url !== stored.url
		) return refused("pull-request");
		if (!ownPullRequest(run.repository, stored.url)) return refused("repository");
		if (
			progress.tasks.some(task =>
				task.state === "completed"
				&& task.pullRequest.url === stored.url
				&& task.pullRequest.state === "merged"
			)
			&& stored.state !== "merged"
		) return refused("pull-request-state");
		let nextTasks = progress.tasks.map(task =>
			task.state === "completed" && task.pullRequest.url === stored.url
				? { ...task, pullRequest: { url: stored.url, state: stored.state } }
				: task
		);
		return accepted({
			phase: deliveryPhase(nextTasks),
			context: state.context,
			progress: { ...progress, tasks: nextTasks },
		});
	}

	if (stored.kind === "request_revision") {
		if (!text(stored.reason)) return refused("reason");
		return accepted({
			phase: "revision_requested",
			context: state.context,
			progress,
			reason: stored.reason,
		});
	}

	if (stored.kind === "report_verification") {
		if (!validReport(stored, tasks)) return refused("verification");
		for (let item of progress.tasks) {
			if (item.state !== "completed") return refused("task-state");
			if (item.pullRequest.state !== "open" && item.pullRequest.state !== "merged") {
				return refused("pull-request");
			}
			if (!ownPullRequest(run.repository, item.pullRequest.url)) {
				return refused("repository");
			}
		}
		let verification = reportFrom(stored);
		if (stored.passed) {
			return accepted({
				phase: deliveryPhase(progress.tasks),
				context: state.context,
				progress: { ...progress, verification },
			});
		}
		let work = new Set(stored.tasksNeedingWork);
		let nextTasks = progress.tasks.map(item =>
			work.has(item.id) && item.state === "completed"
				? {
					id: item.id,
					state: "in_progress" as const,
					pullRequest: copy(item.pullRequest),
				}
				: item
		);
		return accepted({
			phase: "active",
			context: state.context,
			progress: { ...progress, tasks: nextTasks, verification },
		});
	}

	let index = progress.tasks.findIndex(item => item.id === stored.taskId);
	let task = tasks[index];
	let item = progress.tasks[index];
	if (!task || !item) return refused("task");
	let next: TaskProgress;
	switch (stored.kind) {
		case "start":
			if (item.state !== "queued" && item.state !== "blocked") {
				return refused("task-state");
			}
			if (
				task.dependsOn.some(id =>
					progress.tasks.find(item => item.id === id)?.state !== "completed"
				)
			) return refused("dependency");
			next = {
				id: item.id,
				state: "in_progress",
				...(item.state === "blocked" && item.pullRequest
					? { pullRequest: item.pullRequest }
					: {}),
			};
			break;
		case "block":
			if (item.state !== "in_progress") return refused("task-state");
			if (!text(stored.reason)) return refused("reason");
			next = {
				id: item.id,
				state: "blocked",
				blocker: stored.reason,
				...(item.pullRequest ? { pullRequest: item.pullRequest } : {}),
			};
			break;
		case "report_pr": {
			if (item.state === "queued") return refused("task-state");
			if (!text(stored.url) || !pullRequestState(stored.state)) {
				return refused("pull-request");
			}
			if (!ownPullRequest(run.repository, stored.url)) return refused("repository");
			let shared = progress.tasks.filter(task =>
				"pullRequest" in task && task.pullRequest?.url === stored.url
			);
			if (
				shared.some(task => "pullRequest" in task && task.pullRequest?.state === "merged")
				&& stored.state !== "merged"
			) return refused("pull-request-state");
			let pullRequest = { url: stored.url, state: stored.state };
			next = { ...item, pullRequest };
			break;
		}
		case "complete":
			if (item.state !== "in_progress") return refused("task-state");
			if (!item.pullRequest) return refused("pull-request");
			if (!text(stored.summary)) return refused("summary");
			next = {
				id: item.id,
				state: "completed",
				summary: stored.summary,
				pullRequest: item.pullRequest,
			};
			break;
	}
	let nextTasks = progress.tasks.map((task, taskIndex) => {
		if (taskIndex === index) return next;
		return stored.kind === "report_pr" && stored.state === "merged"
				&& "pullRequest" in task && task.pullRequest?.url === stored.url
			? { ...task, pullRequest: { url: stored.url, state: stored.state } }
			: task;
	});
	return accepted({
		phase: "active",
		context: state.context,
		progress: { ...progress, tasks: nextTasks },
	});
}

function foldRun(tasks: Task[], run: Run, events: ProgressEvent[]): Reduction {
	let state = initial(tasks, run);
	for (let stored of events) {
		let result = reduceEvent(state, stored);
		if (result.kind === "refused") return result;
		state = result.state;
	}
	return accepted(state);
}

function projectRun(state: ReducerState, events: ProgressEvent[]): DerivedRun {
	let progress: Progress = {
		...copy(state.progress),
		events: copy(events),
	};
	return state.phase === "revision_requested"
		? { phase: state.phase, progress, reason: state.reason }
		: { phase: state.phase, progress };
}

function evidence(value: unknown): VerificationEvidence[] | undefined {
	if (!Array.isArray(value)) return undefined;
	let restored: VerificationEvidence[] = [];
	for (let entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		let item = entry as Record<string, unknown>;
		if (
			!exact(item, ["evidence", "taskId"])
			|| typeof item.taskId !== "string"
			|| !Array.isArray(item.evidence)
			|| item.evidence.some(value => typeof value !== "string")
		) return undefined;
		restored.push({ taskId: item.taskId, evidence: item.evidence as string[] });
	}
	return restored;
}

function progressEvent(value: unknown): ProgressEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let item = value as Record<string, unknown>;
	if (!text(item.idempotencyKey)) return undefined;
	let idempotencyKey = item.idempotencyKey;
	if (
		item.kind === "request_revision"
		&& exact(item, ["idempotencyKey", "kind", "reason"])
		&& text(item.reason)
	) return { kind: item.kind, reason: item.reason, idempotencyKey };
	if (
		item.kind === "report_verification"
		&& exact(item, [
			"evidence",
			"idempotencyKey",
			"kind",
			"passed",
			"reviewerMethod",
			"summary",
			"tasksNeedingWork",
		])
		&& typeof item.passed === "boolean"
		&& typeof item.summary === "string"
		&& typeof item.reviewerMethod === "string"
		&& Array.isArray(item.tasksNeedingWork)
		&& item.tasksNeedingWork.every(value => typeof value === "string")
	) {
		let restored = evidence(item.evidence);
		return restored
			? {
				kind: item.kind,
				passed: item.passed,
				summary: item.summary,
				reviewerMethod: item.reviewerMethod,
				evidence: restored,
				tasksNeedingWork: item.tasksNeedingWork as string[],
				idempotencyKey,
			}
			: undefined;
	}
	if (!text(item.taskId)) return undefined;
	let taskId = item.taskId;
	if (item.kind === "start" && exact(item, ["idempotencyKey", "kind", "taskId"])) {
		return { kind: item.kind, taskId, idempotencyKey };
	}
	if (
		item.kind === "block"
		&& exact(item, ["idempotencyKey", "kind", "reason", "taskId"])
		&& text(item.reason)
	) return { kind: item.kind, taskId, reason: item.reason, idempotencyKey };
	if (
		item.kind === "report_pr"
		&& exact(item, ["idempotencyKey", "kind", "state", "taskId", "url"])
		&& text(item.url)
		&& pullRequestState(item.state)
	) {
		return {
			kind: item.kind,
			taskId,
			url: item.url,
			state: item.state,
			idempotencyKey,
		};
	}
	if (
		item.kind === "complete"
		&& exact(item, ["idempotencyKey", "kind", "summary", "taskId"])
		&& text(item.summary)
	) return { kind: item.kind, taskId, summary: item.summary, idempotencyKey };
	return undefined;
}

function restoreEvents(value: unknown): ProgressEvent[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	let restored = value.map(progressEvent);
	return restored.some(event => !event) ? undefined : restored as ProgressEvent[];
}

function restoreHistory(stored: unknown, graph: Graph): ArchivedRun[] | undefined {
	if (!Array.isArray(stored)) return undefined;
	let history: ArchivedRun[] = [];
	for (let value of stored) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		let item = value as Record<string, unknown>;
		if (!exact(item, ["events", "run"])) return undefined;
		let run = restoreRunVersion(item.run, graph);
		let events = restoreEvents(item.events);
		if (!run || !events) return undefined;
		history.push({ run, events });
	}
	return history;
}

function projectHistory(graph: Graph, history: ArchivedRun[]): HistoricalRun[] | undefined {
	let projected: HistoricalRun[] = [];
	for (let archived of history) {
		let version = versionFor(graph, archived.run);
		if (!version) return undefined;
		let folded = foldRun(version.definition.tasks, archived.run, archived.events);
		if (folded.kind === "refused") return undefined;
		let derived = projectRun(folded.state, archived.events);
		if (derived.phase === "active") return undefined;
		let outcome: HistoricalRun["outcome"] = derived.phase === "revision_requested"
			? { kind: derived.phase, reason: derived.reason }
			: { kind: derived.phase };
		projected.push({
			run: copy(archived.run),
			progress: copy(derived.progress),
			outcome,
		});
	}
	return projected;
}

function eligibility(
	history: Array<{ run: Run; successful: boolean }>,
	version: Version,
	runId: string,
): ClaimEligibility {
	if (history.some(item => item.successful && matches(item.run, version))) {
		return { ok: false, reason: "already-verified" };
	}
	if (history.some(item => item.run.id === runId)) return { ok: false, reason: "run" };
	return { ok: true };
}

/** Decide whether a run may own this exact graph without reusing lifecycle identity. */
export function claimEligibility(
	lifecycle: Lifecycle,
	version: Version,
	runId: string,
): ClaimEligibility {
	let history = lifecycle.history.map(archived => {
		if (!matches(archived.run, version)) return { run: archived.run, successful: false };
		let folded = foldRun(version.definition.tasks, archived.run, archived.events);
		return {
			run: archived.run,
			successful: folded.kind === "accepted"
				&& (folded.state.phase === "implemented" || folded.state.phase === "delivered"),
		};
	});
	return eligibility(history, version, runId);
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
	let projected = projectHistory(graph, history);
	if (!projected) return undefined;
	let events = stored.events === undefined ? undefined : restoreEvents(stored.events);
	if (stored.events !== undefined && !events) return undefined;
	let current = graph.versions.at(-1);
	if (!current || (current.state === "locked") !== Boolean(execution)) return undefined;
	if (events && !execution) return undefined;
	if (execution) {
		let version = activeVersion(graph, execution);
		if (!version) return undefined;
		let folded = foldRun(version.definition.tasks, execution, events ?? []);
		if (folded.kind === "refused" || folded.state.phase !== "active") return undefined;
		let eligible = eligibility(
			projected.map(item => ({
				run: item.run,
				successful: item.outcome.kind !== "revision_requested",
			})),
			version,
			execution.id,
		);
		if (!eligible.ok) {
			return undefined;
		}
	}

	let runIds = history.map(item => item.run.id);
	if (new Set(runIds).size !== runIds.length) return undefined;
	let allEvents = [...(events ?? []), ...history.flatMap(item => item.events)];
	if (new Set(allEvents.map(event => event.idempotencyKey)).size !== allEvents.length) {
		return undefined;
	}
	let successful = new Set<string>();
	for (let [index, archived] of history.entries()) {
		if (projected[index]?.outcome.kind === "revision_requested") continue;
		let reference = [
			archived.run.graphVersion,
			archived.run.graphRevision,
			archived.run.planRevision,
		].join(":");
		if (successful.has(reference)) return undefined;
		successful.add(reference);
	}
	return { ...(events ? { events } : {}), history };
}

function event(input: LifecycleInput): ProgressEvent {
	switch (input.kind) {
		case "start":
			return {
				kind: input.kind,
				taskId: input.taskId,
				idempotencyKey: input.idempotencyKey,
			};
		case "block":
			return {
				kind: input.kind,
				taskId: input.taskId,
				reason: input.reason,
				idempotencyKey: input.idempotencyKey,
			};
		case "report_pr":
			return {
				kind: input.kind,
				taskId: input.taskId,
				url: input.url,
				state: input.state,
				idempotencyKey: input.idempotencyKey,
			};
		case "complete":
			return {
				kind: input.kind,
				taskId: input.taskId,
				summary: input.summary,
				idempotencyKey: input.idempotencyKey,
			};
		case "report_verification":
			return {
				kind: input.kind,
				...reportFrom(input),
				idempotencyKey: input.idempotencyKey,
			};
		case "request_revision":
			return {
				kind: input.kind,
				reason: input.reason,
				idempotencyKey: input.idempotencyKey,
			};
	}
}

function sameEvidence(left: VerificationEvidence[], right: VerificationEvidence[]): boolean {
	return left.length === right.length && left.every((entry, index) => {
		let other = right[index];
		return entry.taskId === other?.taskId
			&& entry.evidence.length === other.evidence.length
			&& entry.evidence.every((value, evidenceIndex) => value === other.evidence[evidenceIndex]);
	});
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
				&& stored.url === input.url && stored.state === input.state;
		case "complete":
			return input.kind === "complete" && stored.taskId === input.taskId
				&& stored.summary === input.summary;
		case "report_verification":
			return input.kind === "report_verification"
				&& stored.passed === input.passed
				&& stored.summary === input.summary
				&& stored.reviewerMethod === input.reviewerMethod
				&& sameEvidence(stored.evidence, input.evidence)
				&& stored.tasksNeedingWork.length === input.tasksNeedingWork.length
				&& stored.tasksNeedingWork.every((value, index) => value === input.tasksNeedingWork[index]);
		case "request_revision":
			return input.kind === "request_revision" && stored.reason === input.reason;
	}
}

function replay(state: LifecycleState, input: LifecycleInput): LifecycleResult | undefined {
	let owned = [
		...(state.execution
			? (state.lifecycle.events ?? []).map(event => ({ runId: state.execution!.id, event }))
			: []),
		...state.lifecycle.history.flatMap(item =>
			item.events.map(event => ({ runId: item.run.id, event }))
		),
	];
	let prior = owned.find(item => item.event.idempotencyKey === input.idempotencyKey);
	return prior
		? prior.runId === input.runId && same(prior.event, input)
			? { kind: "replayed", state: copy(state) }
			: { kind: "refused", reason: "idempotency-conflict" }
		: undefined;
}

function released(
	state: LifecycleState,
	run: Run,
	events: ProgressEvent[],
): LifecycleState {
	let next = copy(state);
	let version = next.graph.versions.at(-1)!;
	next.graph.versions[next.graph.versions.length - 1] = { ...version, state: "approved" };
	next.execution = undefined;
	next.lifecycle = {
		history: [...next.lifecycle.history, { run: copy(run), events: copy(events) }],
	};
	return next;
}

/** Apply one lifecycle event without mutating the graph or claim identity. */
export function transition(state: LifecycleState, input: LifecycleInput): LifecycleResult {
	if (!text(input.runId)) return { kind: "refused", reason: "run" };
	if (!text(input.idempotencyKey)) {
		return { kind: "refused", reason: "idempotency-key" };
	}
	let prior = replay(state, input);
	if (prior) return prior;

	let archivedIndex = state.lifecycle.history.findIndex(item => item.run.id === input.runId);
	if (archivedIndex >= 0) {
		if (input.kind !== "report_pr") return { kind: "refused", reason: "inactive" };
		let archived = state.lifecycle.history[archivedIndex]!;
		let version = versionFor(state.graph, archived.run);
		if (!version) return { kind: "refused", reason: "inactive" };
		let folded = foldRun(version.definition.tasks, archived.run, archived.events);
		if (folded.kind === "refused") return folded;
		let stored = event(input);
		let reduced = reduceEvent(folded.state, stored);
		if (reduced.kind === "refused") return reduced;
		if (reduced.state.phase === "active" || reduced.state.phase === "revision_requested") {
			return { kind: "refused", reason: "inactive" };
		}
		let events = [...archived.events, stored];
		let next = copy(state);
		next.lifecycle.history[archivedIndex] = {
			run: copy(archived.run),
			events: copy(events),
		};
		return { kind: "accepted", state: next };
	}

	let run = state.execution;
	let version = run && activeVersion(state.graph, run);
	if (!run || input.runId !== run.id || !version) {
		return { kind: "refused", reason: "run" };
	}
	let existingEvents = state.lifecycle.events ?? [];
	let folded = foldRun(version.definition.tasks, run, existingEvents);
	if (folded.kind === "refused" || folded.state.phase !== "active") {
		return { kind: "refused", reason: "invalid-lifecycle" };
	}
	let stored = event(input);
	let reduced = reduceEvent(folded.state, stored);
	if (reduced.kind === "refused") return reduced;
	let events = [...existingEvents, stored];
	if (reduced.state.phase !== "active") {
		return {
			kind: "accepted",
			state: released(state, run, events),
		};
	}
	return {
		kind: "accepted",
		state: {
			...state,
			lifecycle: { ...state.lifecycle, events: copy(events) },
		},
	};
}

/** Project queued work before the first lifecycle event. */
export function progressFor(
	graph: Graph,
	lifecycle: Lifecycle,
	execution?: Run,
): Progress | undefined {
	if (!execution) return undefined;
	let version = activeVersion(graph, execution);
	if (!version) return undefined;
	let events = lifecycle.events ?? [];
	let folded = foldRun(version.definition.tasks, execution, events);
	if (folded.kind === "refused" || folded.state.phase !== "active") return undefined;
	return projectRun(folded.state, events).progress;
}

/** Project archived event logs against the graph versions they implemented. */
export function historyFor(graph: Graph, lifecycle: Lifecycle): HistoricalRun[] {
	return copy(projectHistory(graph, lifecycle.history) ?? []);
}

/** Project durable lifecycle state into the shape shared by MCP and the wire. */
export function implementationLifecycle(state: LifecycleState): ImplementationLifecycle {
	return {
		execution: state.execution ? { state: "active" } : { state: "idle" },
		activity: progressFor(state.graph, state.lifecycle, state.execution),
		history: historyFor(state.graph, state.lifecycle),
	};
}
