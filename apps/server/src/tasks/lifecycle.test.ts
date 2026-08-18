import { describe, expect, it } from "bun:test";

import type { Graph, Run } from "./graphs";

let tasks = [
	{
		id: "foundation",
		title: "Lay the foundation",
		context: "Delivery depends on this work.",
		goal: "Finish the prerequisite.",
		acceptance: ["The prerequisite completes.", "Its result is recorded."],
		dependsOn: [],
	},
	{
		id: "delivery",
		title: "Deliver the feature",
		context: "This work follows the foundation.",
		goal: "Deliver the implementation.",
		acceptance: ["The dependency is complete.", "Delivery is reported."],
		dependsOn: ["foundation"],
	},
];

let graph: Graph = {
	versions: [{
		number: 1,
		revision: 1,
		planRevision: 3,
		state: "locked",
		definition: { tasks },
	}],
};

let execution: Run = {
	id: "run-1",
	user: "octocat",
	client: { name: "Codex", version: "1.2.3" },
	session: "session-1",
	planRevision: 3,
	graphRevision: 1,
	repository: "githubnext/chopin",
	branch: "tq/018",
	commit: "deadbeef",
	startedAt: "2026-08-13T20:00:00.000Z",
};

async function lifecycle() {
	return await import("./lifecycle").catch(() => ({}));
}

describe("implementation task lifecycle", () => {
	it("keeps mutable progress outside the immutable implementation run", async () => {
		let module = await lifecycle() as {
			transition?: (state: unknown, input: unknown) => any;
			progressFor?: (graph: Graph, lifecycle: unknown, execution?: Run) => any;
		};
		expect(module.transition).toBeTypeOf("function");
		if (!module.transition || !module.progressFor) return;

		let state = { graph, execution, lifecycle: { history: [] } };
		expect(module.transition(state, {
			kind: "start",
			taskId: "foundation",
			idempotencyKey: " ",
		})).toEqual({ kind: "refused", reason: "idempotency-key" });
		expect(module.transition(state, {
			kind: "start",
			taskId: "delivery",
			idempotencyKey: "start-delivery",
		})).toEqual({ kind: "refused", reason: "dependency" });
		let started = module.transition(state, {
			kind: "start",
			taskId: "foundation",
			idempotencyKey: "start-foundation",
		});

		expect(started).toMatchObject({ kind: "accepted", state: { execution } });
		expect(started.state.lifecycle).toEqual({
			history: [],
			events: [{ kind: "start", taskId: "foundation", idempotencyKey: "start-foundation" }],
		});
		expect(module.progressFor(graph, started.state.lifecycle, execution)?.tasks).toEqual([
			{ id: "foundation", state: "in_progress" },
			{ id: "delivery", state: "queued" },
		]);
		expect(started.state.execution).toEqual(execution);
		expect(started.state.execution).not.toHaveProperty("progress");
	});

	it("rejects durable progress that does not exactly describe the locked graph", async () => {
		let module = await lifecycle() as {
			restoreLifecycle?: (value: unknown, graph: Graph, execution: Run | undefined) => unknown;
		};
		expect(module.restoreLifecycle).toBeTypeOf("function");
		if (!module.restoreLifecycle) return;

		let valid = {
			events: [{ kind: "start", taskId: "foundation", idempotencyKey: "start-foundation" }],
			history: [],
		};
		expect(module.restoreLifecycle(valid, graph, execution)).toEqual(valid);
		expect(module.restoreLifecycle(
			{
				...valid,
				events: [{ kind: "start", taskId: "missing", idempotencyKey: "start-missing" }],
			},
			graph,
			execution,
		)).toBeUndefined();
		expect(module.restoreLifecycle(
			{
				...valid,
				events: [{ kind: "start", taskId: "delivery", idempotencyKey: "start-delivery" }],
			},
			graph,
			execution,
		)).toBeUndefined();
		expect(module.restoreLifecycle(
			{
				...valid,
				history: [{
					run: execution,
					events: [{
						kind: "request_revision",
						reason: "Try again.",
						idempotencyKey: "start-foundation",
					}],
					outcome: { kind: "revision_requested", reason: "Try again." },
				}],
			},
			graph,
			execution,
		)).toBeUndefined();
	});

	it("records blockers and repository pull requests before completing work", async () => {
		let module = await lifecycle() as {
			transition: (state: any, input: any) => any;
			progressFor: (graph: Graph, lifecycle: unknown, execution?: Run) => any;
		};
		let state: any = { graph, execution, lifecycle: { history: [] } };
		let apply = (input: unknown) => {
			let result = module.transition(state, input);
			expect(result.kind).toBe("accepted");
			state = result.state;
		};

		apply({ kind: "start", taskId: "foundation", idempotencyKey: "start-foundation" });
		let block = {
			kind: "block",
			taskId: "foundation",
			reason: "Waiting for repository access.",
			idempotencyKey: "block-foundation",
		};
		apply(block);
		expect(module.progressFor(graph, state.lifecycle, execution).tasks[0]).toEqual({
			id: "foundation",
			state: "blocked",
			blocker: "Waiting for repository access.",
		});
		expect(module.transition(state, block)).toMatchObject({ kind: "replayed" });
		expect(module.transition(state, {
			...block,
			reason: "Waiting for CI.",
		})).toEqual({ kind: "refused", reason: "idempotency-conflict" });
		apply({ kind: "start", taskId: "foundation", idempotencyKey: "restart-foundation" });
		expect(module.transition(state, {
			kind: "report_pr",
			taskId: "foundation",
			url: "https://github.com/elsewhere/other/pull/9",
			state: "open",
			idempotencyKey: "foreign-pr",
		})).toEqual({ kind: "refused", reason: "repository" });
		expect(module.transition(state, {
			kind: "complete",
			taskId: "foundation",
			summary: "Implemented the prerequisite.",
			idempotencyKey: "complete-without-pr",
		})).toEqual({ kind: "refused", reason: "pull-request" });
		apply({
			kind: "report_pr",
			taskId: "foundation",
			url: "https://github.com/githubnext/chopin/pull/48",
			state: "open",
			idempotencyKey: "report-pr",
		});
		apply({
			kind: "complete",
			taskId: "foundation",
			summary: "Implemented and verified the prerequisite.",
			idempotencyKey: "complete-foundation",
		});

		expect(module.progressFor(graph, state.lifecycle, execution).tasks[0]).toEqual({
			id: "foundation",
			state: "completed",
			summary: "Implemented and verified the prerequisite.",
			pullRequest: { url: "https://github.com/githubnext/chopin/pull/48", state: "open" },
		});
	});

	it("archives a revision request and validates that durable history against the graph", async () => {
		let module = await lifecycle() as {
			transition: (state: any, input: any) => any;
			restoreLifecycle: (value: unknown, graph: Graph, execution: Run | undefined) => unknown;
			progressFor: (graph: Graph, lifecycle: unknown, execution?: Run) => unknown;
		};
		let input = {
			kind: "request_revision",
			reason: "The graph needs another implementation step.",
			idempotencyKey: "request-revision",
		};
		let result = module.transition({ graph, execution, lifecycle: { history: [] } }, input);

		expect(result).toMatchObject({
			kind: "accepted",
			state: {
				execution: undefined,
				graph: { versions: [{ state: "approved" }] },
				lifecycle: {
					history: [{
						run: execution,
						outcome: {
							kind: "revision_requested",
							reason: "The graph needs another implementation step.",
						},
					}],
				},
			},
		});
		let archived = result.state.lifecycle;
		expect(module.progressFor(result.state.graph, archived, undefined)).toBeUndefined();
		expect(module.restoreLifecycle(archived, result.state.graph, undefined)).toEqual(archived);
		expect(module.transition(result.state, input)).toMatchObject({ kind: "replayed" });
		expect(module.restoreLifecycle(
			{
				...archived,
				history: [{ ...archived.history[0], run: { ...execution, graphRevision: 9 } }],
			},
			result.state.graph,
			undefined,
		)).toBeUndefined();
	});

	it("matches repeated graph revision numbers to historical runs in order", async () => {
		let module = await lifecycle() as {
			transition: (state: any, input: any) => any;
			restoreLifecycle: (value: unknown, graph: Graph, execution: Run | undefined) => unknown;
		};
		let revisedTasks = [{
			id: "replacement",
			title: "Replace the approach",
			context: "The first run exposed a better route.",
			goal: "Implement the replacement.",
			acceptance: ["The replacement works.", "Its result is recorded."],
			dependsOn: [],
		}];
		let revisedGraph: Graph = {
			versions: [
				{ ...graph.versions[0]!, state: "superseded" },
				{
					number: 2,
					revision: 1,
					planRevision: 3,
					state: "locked",
					definition: { tasks: revisedTasks },
				},
			],
		};
		let secondRun = { ...execution, id: "run-2" };
		let released = module.transition(
			{ graph: revisedGraph, execution: secondRun, lifecycle: { history: [] } },
			{
				kind: "request_revision",
				reason: "A third graph is needed.",
				idempotencyKey: "revise-second-run",
			},
		).state;
		let archived = released.lifecycle;

		expect(module.restoreLifecycle(archived, {
			...revisedGraph,
			versions: [revisedGraph.versions[0]!, {
				...revisedGraph.versions[1]!,
				state: "approved",
			}],
		}, undefined)).toEqual(archived);

		let releasedAgain = module.transition({
			...released,
			graph: {
				...released.graph,
				versions: [released.graph.versions[0]!, {
					...released.graph.versions[1]!,
					state: "locked",
				}],
			},
			execution: { ...secondRun, id: "run-3" },
		}, {
			kind: "request_revision",
			reason: "The same graph still needs revision.",
			idempotencyKey: "revise-third-run",
		}).state;
		expect(module.restoreLifecycle(
			releasedAgain.lifecycle,
			releasedAgain.graph,
			undefined,
		)).toEqual(releasedAgain.lifecycle);
	});
});
