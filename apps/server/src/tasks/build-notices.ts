/**
 * The lines Chat gets for a Build: when it opens a pull request, and when it ends. Each has a fixed
 * ID made from the build and what happened, so posting one twice keeps one line, and a restart
 * that sees the same state posts nothing new.
 */

import { implementationLifecycle } from "./lifecycle";
import { blockedTask } from "./build-ending";

import type { Plan } from "../plan/service";

export type BuildNotice = { id: string; text: string };

/** A person's Ctrl-C at the machine's terminal: a stop, not a failure. */
const STOPPED_HERE = "Stopped from the connector terminal.";

type State = Pick<Plan, "graph" | "execution" | "lifecycle" | "builds" | "live">;

/** `#12` linked to its pull request; any other link as itself. */
export function pullRequestLink(url: string): string {
	let number = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1];
	return number ? `[#${number}](${url})` : `<${url}>`;
}

function links(urls: Iterable<string>): string {
	let list = [...new Set(urls)].map(pullRequestLink);
	return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

function sentence(text: string): string {
	let trimmed = text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
	return trimmed.length > 200 ? `${trimmed.slice(0, 200).replace(/\s+\S*$/, "")}…` : trimmed;
}

/** Every notice the current state calls for, in the order they happened. */
export function buildNotices(state: State): BuildNotice[] {
	let graph = state.graph;
	if (!graph) return [];
	let lifecycle = implementationLifecycle({
		graph,
		execution: state.execution,
		lifecycle: state.lifecycle,
	});
	let notices: BuildNotice[] = [];
	let titles = (graphVersion: number) =>
		new Map(
			graph.versions.find(version => version.number === graphVersion)?.definition.tasks
				.map(task => [task.id, task.title]) ?? [],
		);
	let known = new Set(state.live?.pullRequests ?? []);

	// A running first build: each pull request the first time one of its tasks reports it.
	let run = state.execution;
	if (run && lifecycle.activity) {
		let named = titles(run.graphVersion);
		let seen = new Set<string>();
		for (let task of lifecycle.activity.tasks) {
			let url = task.state === "queued" ? undefined : task.pullRequest?.url;
			if (!url || seen.has(url)) continue;
			seen.add(url);
			let title = named.get(task.id);
			notices.push({
				id: `build-pr:${run.id}:${url}`,
				text: `Build ${known.has(url) ? "updated" : "opened"} ${pullRequestLink(url)}${
					title ? ` for “${sentence(title)}”` : ""
				}.`,
			});
		}
	}

	for (let build of state.builds) {
		if (build.state !== "stopped" && build.state !== "failed") continue;
		let id = `build-end:${build.id}`;
		if (build.kind === "rebuild") {
			let updated = (state.live?.commits ?? [])
				.filter(commit => build.finishedAt && commit.at === build.finishedAt)
				.map(commit => commit.pullRequest);
			let unchanged = state.live?.noChange?.some(item => item.buildId === build.id);
			notices.push({
				id,
				text: updated.length
					? `Build finished: updated ${links(updated)}.`
					: unchanged
					? "Build finished: the document needed no code change."
					: build.state === "failed"
					? `Build failed${build.error ? `: ${sentence(build.error)}` : ""}.`
					: `Build stopped${build.error ? `: ${sentence(build.error)}` : ""}.`,
			});
			continue;
		}
		let ended = lifecycle.history.findLast(item => item.run.id === build.id);
		if (ended && (ended.outcome.kind === "implemented" || ended.outcome.kind === "delivered")) {
			let tasks = ended.progress.tasks.filter(task => task.state === "completed");
			let opened = tasks.flatMap(task => task.pullRequest ? [task.pullRequest.url] : []);
			let count = `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`;
			notices.push({
				id,
				text: opened.length
					? `Build finished: ${count}, ${links(opened)}.`
					: `Build finished: ${count}, no code change needed.`,
			});
		} else if (ended && build.stoppedBy) {
			notices.push({ id, text: `Build stopped by @${build.stoppedBy}.` });
		} else if (ended && ended.outcome.kind === "revision_requested") {
			// A blocked task says why better than the release that followed it.
			let blocked = build.state === "stopped"
				? blockedTask(graph, ended.run.graphVersion, ended.progress.tasks)
				: undefined;
			let reason = sentence(ended.outcome.reason);
			notices.push({
				id,
				text: blocked
					? `Build blocked${blocked.task ? ` on “${sentence(blocked.task)}”` : ""}: ${
						sentence(blocked.reason)
					}.`
					: build.state === "failed" && build.error && build.error !== STOPPED_HERE
					? `Build failed: ${sentence(build.error)}.`
					: /^the build stopped before it finished$/i.test(reason)
					? "Build stopped before it finished."
					: `Build stopped: ${reason}.`,
			});
		} else if (run?.id === build.id) {
			// Stopped while its run still holds the tasks: Build offers what to do next.
			notices.push({
				id,
				text: `Build stopped${
					build.error ? `: ${sentence(build.error)}` : ""
				}. Open Build to retry or return it for changes.`,
			});
		} else {
			notices.push({
				id,
				text: build.state === "failed"
					? `Build didn’t start${build.error ? `: ${sentence(build.error)}` : ""}.`
					: `Build stopped${build.error ? `: ${sentence(build.error)}` : ""}.`,
			});
		}
	}
	return notices;
}
