import { expect, test } from "bun:test";

import { buildNotices, pullRequestLink } from "./build-notices";
import { transition } from "./lifecycle";

import type { BuildRequest } from "@chopin/protocol/implementation";
import type { Graph, Run } from "./graphs";
import type { Lifecycle, LifecycleState } from "./lifecycle";

let tasks = ["scaffold", "proof"].map((id, index) => ({
	id,
	title: index === 0 ? "Scaffold the crate" : "Prove the contract",
	context: "The document.",
	goal: "Do it.",
	acceptance: ["It is done.", "It is checked."],
	dependsOn: index === 0 ? [] : ["scaffold"],
}));

let graph: Graph = {
	versions: [{ number: 1, revision: 1, planRevision: 3, state: "locked", definition: { tasks } }],
};

let run: Run = {
	id: "build-1",
	user: "U_ana",
	client: { name: "Fake", version: "1" },
	session: "s",
	planRevision: 3,
	graphVersion: 1,
	graphRevision: 1,
	repository: "octo/score",
	branch: "main",
	commit: "0".repeat(40),
	startedAt: "2026-11-12T10:00:00.000Z",
};

let build: BuildRequest = {
	id: "build-1",
	user: "U_ana",
	connectionId: "c",
	repositoryId: "R",
	checkout: { repository: "octo/score", commit: "0".repeat(40) },
	planRevision: 3,
	graphVersion: 1,
	graphRevision: 1,
	createdAt: "2026-11-12T10:00:00.000Z",
	expiresAt: 0,
	state: "running",
};

const PR = "https://github.com/octo/score/pull/12";

function step(state: LifecycleState, input: Record<string, unknown>): LifecycleState {
	let result = transition(state, { runId: run.id, ...input } as never);
	if (result.kind !== "accepted") throw new Error(result.kind);
	return result.state;
}

function started(): LifecycleState {
	let state: LifecycleState = { graph, execution: run, lifecycle: { history: [] } as Lifecycle };
	state = step(state, { kind: "start", taskId: "scaffold", idempotencyKey: "a" });
	return step(state, {
		kind: "report_pr",
		taskId: "scaffold",
		url: PR,
		state: "open",
		idempotencyKey: "b",
	});
}

test("a running build's pull request is one line, named for its first task, until the build ends", () => {
	let state = started();
	let notices = buildNotices({ ...state, builds: [build], live: undefined });
	expect(notices).toEqual([{
		id: `build-pr:build-1:${PR}`,
		text: `Build opened [#12](${PR}) for “Scaffold the crate”.`,
	}]);
	// The next task reporting the same pull request adds no second line.
	state = step(state, {
		kind: "complete",
		taskId: "scaffold",
		summary: "Done.",
		idempotencyKey: "c",
	});
	state = step(state, { kind: "start", taskId: "proof", idempotencyKey: "d" });
	state = step(state, {
		kind: "report_pr",
		taskId: "proof",
		url: PR,
		state: "open",
		idempotencyKey: "e",
	});
	expect(buildNotices({ ...state, builds: [build], live: undefined })).toEqual(notices);
});

test("a finished build says how many tasks and links its pull requests; a stopped one says why", () => {
	let state = started();
	state = step(state, {
		kind: "complete",
		taskId: "scaffold",
		summary: "Done.",
		idempotencyKey: "c",
	});
	state = step(state, { kind: "start", taskId: "proof", idempotencyKey: "d" });
	let second = "https://github.com/octo/score/pull/13";
	state = step(state, {
		kind: "report_pr",
		taskId: "proof",
		url: second,
		state: "open",
		idempotencyKey: "e",
	});
	state = step(state, { kind: "complete", taskId: "proof", summary: "Done.", idempotencyKey: "f" });
	state = step(state, {
		kind: "report_verification",
		passed: true,
		summary: "Both pass.",
		reviewerMethod: "Ran the checks.",
		evidence: tasks.map(task => ({ taskId: task.id, evidence: ["passed"] })),
		tasksNeedingWork: [],
		idempotencyKey: "v",
	});
	expect(state.execution).toBeUndefined();
	let ended = { ...build, state: "stopped" as const, finishedAt: "2026-11-12T11:00:00.000Z" };
	let notices = buildNotices({ ...state, builds: [ended], live: undefined });
	expect(notices.at(-1)).toEqual({
		id: "build-end:build-1",
		text: `Build finished: 2 tasks, [#12](${PR}) and [#13](${second}).`,
	});

	let blocked = step(started(), {
		kind: "request_revision",
		reason: "The verifier refused the crate.",
		idempotencyKey: "r",
	});
	expect(buildNotices({ ...blocked, builds: [ended], live: undefined }).at(-1)).toEqual({
		id: "build-end:build-1",
		text: "Build stopped: The verifier refused the crate.",
	});

	let failed = { ...build, state: "failed" as const, error: "The agent did not start." };
	expect(buildNotices({ graph, lifecycle: { history: [] }, builds: [failed], live: undefined }))
		.toEqual([{ id: "build-end:build-1", text: "Build didn’t start: The agent did not start." }]);
});

test("a rebuild that lands says which pull requests it updated", () => {
	let at = "2026-11-12T12:00:00.000Z";
	let rebuild: BuildRequest = {
		...build,
		id: "rebuild-1",
		kind: "rebuild",
		state: "stopped",
		finishedAt: at,
	};
	let notices = buildNotices({
		graph,
		lifecycle: { history: [] },
		builds: [rebuild],
		live: {
			pullRequests: [PR],
			commits: [
				{
					pullRequest: PR,
					sha: "a",
					message: "older",
					revision: 2,
					at: "2026-11-12T11:00:00.000Z",
				},
				{ pullRequest: PR, sha: "b", message: "edit", revision: 4, at },
			],
		} as never,
	});
	expect(notices).toEqual([{
		id: "build-end:rebuild-1",
		text: `Build finished: updated [#12](${PR}).`,
	}]);
});

test("a pull request link is its number, and anything else is the link itself", () => {
	expect(pullRequestLink(PR)).toBe(`[#12](${PR})`);
	expect(pullRequestLink("https://example.com/x")).toBe("<https://example.com/x>");
});
