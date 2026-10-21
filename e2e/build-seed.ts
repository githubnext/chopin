import type { BuildRequest } from "../packages/protocol/implementation";
import type { Graph, Run } from "../apps/server/src/tasks/graphs";
import { type Lifecycle, transition } from "../apps/server/src/tasks/lifecycle";

/** A first build of the graph's latest tasks that failed before it claimed them, so Build is on. */
export function failedBuild(graph: Graph): BuildRequest {
	let version = graph.versions.at(-1)!;
	return {
		id: crypto.randomUUID(),
		user: "U_e2e",
		connectionId: "seeded",
		repositoryId: "R_score",
		checkout: { repository: "octo-org/score", commit: "0".repeat(40) },
		planRevision: version.planRevision,
		graphVersion: version.number,
		graphRevision: version.revision,
		createdAt: new Date().toISOString(),
		expiresAt: 0,
		state: "failed",
		error: "The agent did not start.",
	};
}

/**
 * A first build of the graph's latest tasks that delivered a pull request for each and passed
 * review, asked for at `asked` and finished at `finished`: the document reads as built. A task
 * named in `noChange` instead completes as needing no code change, with no pull request.
 */
export function builtBuild(
	draft: Graph,
	asked: Date,
	finished: Date,
	noChange: Record<string, { reason: string; evidence: string }> = {},
): { graph: Graph; builds: BuildRequest[]; lifecycle: Lifecycle } {
	let { error: _error, ...build } = failedBuild(draft);
	let version = draft.versions.at(-1)!;
	let run: Run = {
		id: build.id,
		user: build.user,
		client: { name: "Fake implementer", version: "1.0.0" },
		session: "seeded",
		planRevision: version.planRevision,
		graphVersion: version.number,
		graphRevision: version.revision,
		repository: build.checkout.repository,
		branch: "main",
		commit: build.checkout.commit,
		startedAt: asked.toISOString(),
	};
	let state: Parameters<typeof transition>[0] = {
		graph: { versions: [...draft.versions.slice(0, -1), { ...version, state: "locked" }] },
		execution: run,
		lifecycle: { history: [] },
	};
	let apply = (input: Parameters<typeof transition>[1]) => {
		let result = transition(state, input);
		if (result.kind === "refused") {
			throw new Error(`The seeded build was refused: ${result.reason}`);
		}
		state = result.state;
	};
	for (let [index, task] of version.definition.tasks.entries()) {
		apply({ kind: "start", runId: run.id, taskId: task.id, idempotencyKey: `start-${task.id}` });
		let declared = noChange[task.id];
		if (declared) {
			apply({
				kind: "complete",
				runId: run.id,
				taskId: task.id,
				summary: `Checked ${task.id}.`,
				noChange: declared,
				idempotencyKey: `complete-${task.id}`,
			});
			continue;
		}
		apply({
			kind: "report_pr",
			runId: run.id,
			taskId: task.id,
			url: `https://github.com/octo-org/score/pull/${index + 1}`,
			state: "open",
			idempotencyKey: `pr-${task.id}`,
		});
		apply({
			kind: "complete",
			runId: run.id,
			taskId: task.id,
			summary: `Completed ${task.id}.`,
			idempotencyKey: `complete-${task.id}`,
		});
	}
	apply({
		kind: "report_verification",
		runId: run.id,
		passed: true,
		summary: "Every acceptance criterion passed.",
		reviewerMethod: "Read the pull requests.",
		evidence: version.definition.tasks.map(task => ({ taskId: task.id, evidence: ["Seeded."] })),
		tasksNeedingWork: [],
		idempotencyKey: "verified",
	});
	return {
		graph: state.graph,
		builds: [{
			...build,
			createdAt: asked.toISOString(),
			finishedAt: finished.toISOString(),
			state: "stopped",
		}],
		lifecycle: state.lifecycle,
	};
}
