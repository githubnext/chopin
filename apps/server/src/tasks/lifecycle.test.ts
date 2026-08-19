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
	graphVersion: 1,
	graphRevision: 1,
	repository: "githubnext/chopin",
	branch: "tq/018",
	commit: "deadbeef",
	startedAt: "2026-08-13T20:00:00.000Z",
};

async function lifecycle() {
	return await import("./lifecycle").catch(() => ({}));
}

function apply(module: any, state: any, input: Record<string, unknown>) {
	let result = module.transition(state, input);
	expect(result.kind).toBe("accepted");
	return result.state;
}

function completed(module: any, urls = [
	"https://github.com/githubnext/chopin/pull/48",
	"https://github.com/githubnext/chopin/pull/49",
], states: Array<"open" | "merged" | "closed"> = ["open", "open"]) {
	let state: any = { graph, execution, lifecycle: { history: [] } };
	for (let [index, task] of tasks.entries()) {
		state = apply(module, state, {
			kind: "start",
			runId: execution.id,
			taskId: task.id,
			idempotencyKey: `start-${task.id}`,
		});
		state = apply(module, state, {
			kind: "report_pr",
			runId: execution.id,
			taskId: task.id,
			url: urls[index],
			state: states[index],
			idempotencyKey: `pr-${task.id}`,
		});
		state = apply(module, state, {
			kind: "complete",
			runId: execution.id,
			taskId: task.id,
			summary: `Completed ${task.id}.`,
			idempotencyKey: `complete-${task.id}`,
		});
	}
	return state;
}

function verification(
	passed: boolean,
	tasksNeedingWork: string[],
	idempotencyKey = passed ? "verification-passed" : "verification-failed",
) {
	return {
		kind: "report_verification",
		runId: execution.id,
		passed,
		summary: passed ? "Every acceptance criterion passed." : "One task needs another pass.",
		reviewerMethod: "Ran the focused lifecycle suite and inspected the PR diff.",
		evidence: [
			{ taskId: "foundation", evidence: ["bun test: foundation passed"] },
			{ taskId: "delivery", evidence: ["bun test: delivery passed"] },
		],
		tasksNeedingWork,
		idempotencyKey,
	};
}

describe("implementation task lifecycle", () => {
	it("keeps failed verification active and returns named tasks to work", async () => {
		let module = await lifecycle() as any;
		let state = completed(module);
		let failed = verification(false, ["foundation"]);
		let result = module.transition(state, failed);

		expect(result).toMatchObject({
			kind: "accepted",
			state: {
				execution,
				graph: { versions: [{ state: "locked" }] },
			},
		});
		expect(result.state.lifecycle.events.at(-1)).toEqual({
			kind: "report_verification",
			passed: false,
			summary: failed.summary,
			reviewerMethod: failed.reviewerMethod,
			evidence: failed.evidence,
			tasksNeedingWork: ["foundation"],
			idempotencyKey: "verification-failed",
		});
		let progress = module.progressFor(graph, result.state.lifecycle, execution);
		expect(progress.verification).toEqual({
			passed: false,
			summary: failed.summary,
			reviewerMethod: failed.reviewerMethod,
			evidence: failed.evidence,
			tasksNeedingWork: ["foundation"],
		});
		expect(progress.tasks).toEqual([
			{
				id: "foundation",
				state: "in_progress",
				pullRequest: { url: "https://github.com/githubnext/chopin/pull/48", state: "open" },
			},
			{
				id: "delivery",
				state: "completed",
				summary: "Completed delivery.",
				pullRequest: { url: "https://github.com/githubnext/chopin/pull/49", state: "open" },
			},
		]);

		for (
			let invalid of [
				verification(false, [], "failure-without-work"),
				verification(false, ["foundation", "foundation"], "duplicate-work"),
				verification(false, ["missing"], "unknown-work"),
				verification(true, ["foundation"], "passing-with-work"),
				{
					...verification(false, ["foundation"], "missing-evidence"),
					evidence: [{ taskId: "foundation", evidence: ["only one task"] }],
				},
				{
					...verification(false, ["foundation"], "duplicate-evidence"),
					evidence: [
						{ taskId: "foundation", evidence: ["one"] },
						{ taskId: "foundation", evidence: ["two"] },
					],
				},
				{
					...verification(false, ["foundation"], "empty-evidence"),
					evidence: [
						{ taskId: "foundation", evidence: [] },
						{ taskId: "delivery", evidence: ["one"] },
					],
				},
			]
		) {
			expect(module.transition(state, invalid)).toMatchObject({ kind: "refused" });
		}
	});

	it("archives a passing verification without storing terminal status", async () => {
		let module = await lifecycle() as any;
		let state = completed(module);
		let report = verification(true, []);
		expect(module.transition(
			{ graph, execution, lifecycle: { history: [] } },
			report,
		)).toMatchObject({ kind: "refused" });
		let result = module.transition(state, report);

		expect(result).toMatchObject({
			kind: "accepted",
			state: {
				execution: undefined,
				graph: { versions: [{ state: "approved" }] },
				lifecycle: { history: [{ run: execution }] },
			},
		});
		expect(result.state.lifecycle).not.toHaveProperty("events");
		expect(Object.keys(result.state.lifecycle.history[0]).sort()).toEqual(["events", "run"]);
		expect(result.state.lifecycle.history[0].events.at(-1)).toEqual({
			kind: "report_verification",
			passed: true,
			summary: report.summary,
			reviewerMethod: report.reviewerMethod,
			evidence: report.evidence,
			tasksNeedingWork: [],
			idempotencyKey: "verification-passed",
		});
		expect(module.historyFor(result.state.graph, result.state.lifecycle)).toMatchObject([{
			outcome: { kind: "implemented" },
			progress: { verification: { passed: true } },
		}]);
		expect(module.restoreLifecycle(
			result.state.lifecycle,
			result.state.graph,
			undefined,
		)).toEqual(result.state.lifecycle);
		expect(module.transition(result.state, report)).toMatchObject({ kind: "replayed" });

		let closed = completed(module, undefined, ["closed", "open"]);
		expect(module.transition(closed, verification(true, [], "closed-pr"))).toMatchObject({
			kind: "refused",
		});
	});

	it("derives delivery only after every distinct associated PR merges", async () => {
		let module = await lifecycle() as any;
		let state = module.transition(completed(module), verification(true, [])).state;
		expect(module.historyFor(state.graph, state.lifecycle)[0].outcome).toEqual({
			kind: "implemented",
		});

		state = apply(module, state, {
			kind: "report_pr",
			runId: execution.id,
			taskId: "foundation",
			url: "https://github.com/githubnext/chopin/pull/48",
			state: "merged",
			idempotencyKey: "merge-foundation",
		});
		expect(module.historyFor(state.graph, state.lifecycle)[0].outcome).toEqual({
			kind: "implemented",
		});
		state = apply(module, state, {
			kind: "report_pr",
			runId: execution.id,
			taskId: "delivery",
			url: "https://github.com/githubnext/chopin/pull/49",
			state: "merged",
			idempotencyKey: "merge-delivery",
		});
		expect(module.historyFor(state.graph, state.lifecycle)[0].outcome).toEqual({
			kind: "delivered",
		});
		let immediate = module.transition(
			completed(module, undefined, ["merged", "merged"]),
			verification(true, []),
		).state;
		expect(module.historyFor(immediate.graph, immediate.lifecycle)[0].outcome).toEqual({
			kind: "delivered",
		});

		let sharedUrl = "https://github.com/githubnext/chopin/pull/50";
		let shared = module.transition(
			completed(module, [sharedUrl, sharedUrl]),
			verification(true, []),
		).state;
		shared = apply(module, shared, {
			kind: "report_pr",
			runId: execution.id,
			taskId: "foundation",
			url: sharedUrl,
			state: "merged",
			idempotencyKey: "merge-shared",
		});
		let historical = module.historyFor(shared.graph, shared.lifecycle)[0];
		expect(historical.outcome).toEqual({ kind: "delivered" });
		expect(historical.progress.tasks.map((task: any) => task.pullRequest.state)).toEqual([
			"merged",
			"merged",
		]);
		expect(module.transition(shared, {
			kind: "report_pr",
			runId: execution.id,
			taskId: "delivery",
			url: sharedUrl,
			state: "open",
			idempotencyKey: "regress-shared",
		})).toMatchObject({ kind: "refused" });
		expect(module.transition(shared, {
			kind: "report_pr",
			runId: execution.id,
			taskId: "delivery",
			url: "https://github.com/githubnext/chopin/pull/99",
			state: "merged",
			idempotencyKey: "replace-shared",
		})).toMatchObject({ kind: "refused" });
	});

	it("routes every command to its explicit run", async () => {
		let module = await lifecycle() as any;
		let older = module.transition(completed(module), verification(true, [])).state;
		let newerRun = { ...execution, id: "run-2", graphVersion: 2 };
		let newer: any = {
			graph: {
				versions: [
					{ ...older.graph.versions[0], state: "superseded" },
					{
						...older.graph.versions[0],
						number: 2,
						state: "locked",
					},
				],
			},
			execution: newerRun,
			lifecycle: older.lifecycle,
		};

		expect(module.transition(newer, {
			kind: "start",
			runId: "missing-run",
			taskId: "foundation",
			idempotencyKey: "wrong-run",
		})).toMatchObject({ kind: "refused" });
		expect(module.transition(newer, {
			kind: "request_revision",
			runId: execution.id,
			reason: "Do not revise the newer run.",
			idempotencyKey: "wrong-revision-run",
		})).toMatchObject({ kind: "refused" });

		let deliveryUpdate = {
			kind: "report_pr",
			runId: execution.id,
			taskId: "foundation",
			url: "https://github.com/githubnext/chopin/pull/48",
			state: "merged",
			idempotencyKey: "merge-older-run",
		};
		newer = apply(module, newer, deliveryUpdate);
		expect(module.progressFor(newer.graph, newer.lifecycle, newerRun).tasks).toEqual([
			{ id: "foundation", state: "queued" },
			{ id: "delivery", state: "queued" },
		]);
		expect(module.transition(newer, deliveryUpdate)).toMatchObject({ kind: "replayed" });
		expect(module.transition(newer, {
			...deliveryUpdate,
			runId: newerRun.id,
		})).toEqual({ kind: "refused", reason: "idempotency-conflict" });
		newer = apply(module, newer, {
			kind: "start",
			runId: newerRun.id,
			taskId: "foundation",
			idempotencyKey: "start-newer-run",
		});
		expect(module.historyFor(newer.graph, newer.lifecycle)[0].progress.tasks[0].pullRequest.state)
			.toBe("merged");
	});

	it("rejects impossible active and archived event histories", async () => {
		let module = await lifecycle() as any;
		let ready = completed(module);
		let verified = module.transition(ready, verification(true, [])).state;
		let archived = verified.lifecycle.history[0];

		expect(module.restoreLifecycle(
			{ events: archived.events, history: [] },
			graph,
			execution,
		)).toBeUndefined();
		expect(module.restoreLifecycle(
			{ history: [{ run: execution, events: ready.lifecycle.events }] },
			verified.graph,
			undefined,
		)).toBeUndefined();
		expect(module.restoreLifecycle(
			{
				history: [{
					run: execution,
					events: [
						{
							kind: "request_revision",
							reason: "The graph is incomplete.",
							idempotencyKey: "revise",
						},
						{ kind: "start", taskId: "foundation", idempotencyKey: "too-late" },
					],
				}],
			},
			verified.graph,
			undefined,
		)).toBeUndefined();
		expect(module.restoreLifecycle(
			{
				history: [{
					run: execution,
					events: [
						...archived.events,
						{ kind: "start", taskId: "foundation", idempotencyKey: "post-verification-work" },
					],
				}],
			},
			verified.graph,
			undefined,
		)).toBeUndefined();
		expect(module.restoreLifecycle(
			{
				history: [{
					run: execution,
					events: archived.events.map((event: any, index: number) =>
						index === 0 ? { ...event, runId: execution.id } : event
					),
				}],
			},
			verified.graph,
			undefined,
		)).toBeUndefined();

		let second = {
			run: { ...execution, id: "run-2" },
			events: archived.events.map((event: any) => ({
				...event,
				idempotencyKey: `${event.idempotencyKey}-second`,
			})),
		};
		expect(module.restoreLifecycle(
			{ history: [archived, second] },
			verified.graph,
			undefined,
		)).toBeUndefined();
	});

	it("rejects duplicate run ids and idempotency keys globally", async () => {
		let module = await lifecycle() as any;
		let started = module.transition(
			{ graph, execution, lifecycle: { history: [] } },
			{
				kind: "start",
				runId: execution.id,
				taskId: "foundation",
				idempotencyKey: "shared-key",
			},
		).state;
		expect(module.transition(started, {
			kind: "start",
			runId: "run-2",
			taskId: "foundation",
			idempotencyKey: "shared-key",
		})).toEqual({ kind: "refused", reason: "idempotency-conflict" });

		let released = module.transition(
			{ graph, execution, lifecycle: { history: [] } },
			{
				kind: "request_revision",
				runId: execution.id,
				reason: "Revise this graph.",
				idempotencyKey: "request-revision",
			},
		).state;
		let archived = released.lifecycle.history[0];
		let distinctEvents = archived.events.map((event: any) => ({
			...event,
			idempotencyKey: `${event.idempotencyKey}-second`,
		}));

		expect(module.restoreLifecycle(
			{ history: [archived, { run: execution, events: distinctEvents }] },
			released.graph,
			undefined,
		)).toBeUndefined();
		expect(module.restoreLifecycle(
			{
				history: [archived, {
					run: { ...execution, id: "run-2" },
					events: archived.events,
				}],
			},
			released.graph,
			undefined,
		)).toBeUndefined();

		let activeRun = { ...execution, id: "run-2" };
		expect(module.restoreLifecycle(
			{
				events: [{
					kind: "start",
					taskId: "foundation",
					idempotencyKey: "request-revision",
				}],
				history: [archived],
			},
			graph,
			activeRun,
		)).toBeUndefined();
		expect(module.restoreLifecycle(
			{
				events: [{
					kind: "start",
					taskId: "foundation",
					idempotencyKey: "active-start",
				}],
				history: [archived],
			},
			graph,
			execution,
		)).toBeUndefined();
	});

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
			runId: execution.id,
			taskId: "foundation",
			idempotencyKey: " ",
		})).toEqual({ kind: "refused", reason: "idempotency-key" });
		expect(module.transition(state, {
			kind: "start",
			runId: execution.id,
			taskId: "delivery",
			idempotencyKey: "start-delivery",
		})).toEqual({ kind: "refused", reason: "dependency" });
		let started = module.transition(state, {
			kind: "start",
			runId: execution.id,
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

		apply({
			kind: "start",
			runId: execution.id,
			taskId: "foundation",
			idempotencyKey: "start-foundation",
		});
		let block = {
			kind: "block",
			runId: execution.id,
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
		apply({
			kind: "start",
			runId: execution.id,
			taskId: "foundation",
			idempotencyKey: "restart-foundation",
		});
		expect(module.transition(state, {
			kind: "report_pr",
			runId: execution.id,
			taskId: "foundation",
			url: "https://github.com/elsewhere/other/pull/9",
			state: "open",
			idempotencyKey: "foreign-pr",
		})).toEqual({ kind: "refused", reason: "repository" });
		expect(module.transition(state, {
			kind: "complete",
			runId: execution.id,
			taskId: "foundation",
			summary: "Implemented the prerequisite.",
			idempotencyKey: "complete-without-pr",
		})).toEqual({ kind: "refused", reason: "pull-request" });
		apply({
			kind: "report_pr",
			runId: execution.id,
			taskId: "foundation",
			url: "https://github.com/githubnext/chopin/pull/48",
			state: "open",
			idempotencyKey: "report-pr",
		});
		apply({
			kind: "complete",
			runId: execution.id,
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

	it("preserves revision request as an unsuccessful release", async () => {
		let module = await lifecycle() as {
			transition: (state: any, input: any) => any;
			restoreLifecycle: (value: unknown, graph: Graph, execution: Run | undefined) => unknown;
			progressFor: (graph: Graph, lifecycle: unknown, execution?: Run) => unknown;
			historyFor: (graph: Graph, lifecycle: unknown) => any;
		};
		let input = {
			kind: "request_revision",
			runId: execution.id,
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
					history: [{ run: execution }],
				},
			},
		});
		let archived = result.state.lifecycle;
		expect(module.historyFor(result.state.graph, archived)[0].outcome).toEqual({
			kind: "revision_requested",
			reason: "The graph needs another implementation step.",
		});
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
		let secondRun = { ...execution, id: "run-2", graphVersion: 2 };
		let released = module.transition(
			{ graph: revisedGraph, execution: secondRun, lifecycle: { history: [] } },
			{
				kind: "request_revision",
				runId: secondRun.id,
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
			runId: "run-3",
			reason: "The same graph still needs revision.",
			idempotencyKey: "revise-third-run",
		}).state;
		expect(module.restoreLifecycle(
			releasedAgain.lifecycle,
			releasedAgain.graph,
			undefined,
		)).toEqual(releasedAgain.lifecycle);
	});

	it("derives historical progress from the run's exact graph version", async () => {
		let module = await lifecycle() as {
			historyFor: (graph: Graph, lifecycle: unknown) => unknown;
		};
		let replacement = {
			id: "replacement",
			title: "Replace the approach",
			context: "The later graph removes work that is no longer needed.",
			goal: "Implement the replacement.",
			acceptance: ["The replacement works.", "Its result is recorded."],
			dependsOn: [],
		};
		let legacy = {
			id: "legacy",
			title: "Retire the old approach",
			context: "This task exists only in the earlier graph version.",
			goal: "Remove obsolete work.",
			acceptance: ["The task is retired.", "The graph no longer needs it."],
			dependsOn: [],
		};
		let versions: Graph = {
			versions: [
				{
					number: 1,
					revision: 1,
					planRevision: 3,
					state: "superseded",
					definition: { tasks: [replacement, legacy] },
				},
				{
					number: 2,
					revision: 1,
					planRevision: 3,
					state: "approved",
					definition: { tasks: [replacement] },
				},
			],
		};

		let history = module.historyFor(versions, {
			history: [{
				run: { ...execution, graphVersion: 2 },
				events: [
					{ kind: "start", taskId: "replacement", idempotencyKey: "start-replacement" },
					{
						kind: "request_revision",
						reason: "A newer graph superseded it.",
						idempotencyKey: "request-revision",
					},
				],
			}],
		}) as Array<{ progress: { tasks: unknown } }>;
		expect(history[0]?.progress.tasks).toEqual([{ id: "replacement", state: "in_progress" }]);
	});
});
