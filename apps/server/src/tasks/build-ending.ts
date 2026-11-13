/**
 * How a first build ended, said the same way wherever it shows: the run record, Chat's end line,
 * the Build tab and the machine's terminal. A person stopped it, its agent blocked a task, it
 * failed, or it finished and opened its pull requests.
 */

import { historyFor, progressFor } from "./lifecycle";

import type { BuildRequest } from "@chopin/protocol/implementation";
import type { Graph } from "./graphs";
import type { LifecycleState } from "./lifecycle";

export type BuildEnding =
	/** A person pressed Stop in Chopin; `by` is their login. */
	| { kind: "stopped"; by: string }
	/** The agent blocked a task and ended its turn; `task` is its title when it is known. */
	| { kind: "blocked"; task?: string; reason: string }
	| { kind: "failed"; error: string }
	| { kind: "finished"; pullRequests: string[]; tasks: number }
	/** The agent or a reviewer returned the run for changes. */
	| { kind: "returned"; reason: string }
	/** The agent ended its turn with tasks left and said nothing about them. */
	| { kind: "unfinished" };

const UNFINISHED = "The build stopped before it finished.";

/** What a person's Stop records as the build's error and its run's reason. */
export function stoppedIn(login: string): string {
	return `Stopped in Chopin by @${login}.`;
}

/** The first task the agent left blocked, with its title. */
export function blockedTask(
	graph: Graph,
	graphVersion: number,
	tasks: readonly { id: string; state: string; blocker?: string }[],
): { task?: string; reason: string } | undefined {
	let blocked = tasks.find(task => task.state === "blocked" && task.blocker?.trim());
	if (!blocked?.blocker) return;
	let title = graph.versions.find(version => version.number === graphVersion)?.definition.tasks
		.find(task => task.id === blocked.id)?.title;
	return { ...(title ? { task: title } : {}), reason: blocked.blocker.trim() };
}

/**
 * Why a build's run is returned once the build has ended: who stopped it, the task its agent
 * blocked, or the build's error. `state` holds the run still claimed.
 */
export function endedReason(state: LifecycleState, build: BuildRequest): string {
	if (build.stoppedBy) return stoppedIn(build.stoppedBy);
	let run = state.execution;
	let tasks = run ? progressFor(state.graph, state.lifecycle, run)?.tasks ?? [] : [];
	// Only the agent's own end leaves a blocker standing as the reason; a failure says what failed.
	let blocked = build.state === "stopped" && run
		? blockedTask(state.graph, run.graphVersion, tasks)
		: undefined;
	if (blocked) return `${blocked.task ? `“${blocked.task}” is blocked: ` : ""}${blocked.reason}`;
	return build.error ?? UNFINISHED;
}

/** How `build` ended, once it has; a rebuild or a build still running has no ending here. */
export function buildEnding(state: LifecycleState, build: BuildRequest): BuildEnding | undefined {
	if (build.kind === "rebuild" || !["stopped", "failed"].includes(build.state)) return;
	if (build.stoppedBy) return { kind: "stopped", by: build.stoppedBy };
	let ended = historyFor(state.graph, state.lifecycle).findLast(item => item.run.id === build.id);
	if (ended && (ended.outcome.kind === "implemented" || ended.outcome.kind === "delivered")) {
		let done = ended.progress.tasks.filter(task => task.state === "completed");
		let pullRequests = [
			...new Set(done.flatMap(task => task.pullRequest ? [task.pullRequest.url] : [])),
		];
		return { kind: "finished", pullRequests, tasks: done.length };
	}
	if (ended && build.state === "stopped") {
		let blocked = blockedTask(state.graph, ended.run.graphVersion, ended.progress.tasks);
		if (blocked) return { kind: "blocked", ...blocked };
	}
	if (build.state === "failed") {
		return { kind: "failed", error: build.error ?? "The build failed." };
	}
	if (ended?.outcome.kind === "revision_requested" && ended.outcome.reason !== UNFINISHED) {
		return { kind: "returned", reason: ended.outcome.reason };
	}
	return { kind: "unfinished" };
}
