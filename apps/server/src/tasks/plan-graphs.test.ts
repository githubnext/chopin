import { describe, expect, it } from "bun:test";

import * as graphPlans from "./plan-graphs";
import {
	claimImplementation,
	implementationGraphs,
	reportImplementationLifecycle,
} from "./plan-graphs";
import { readRebuild, reportBuild, reportRebuild } from "./builds";
import { MemoryStorage } from "../storage/memory/adapter";
import { claimStored, close, implementationActive, open, source } from "../plan/service";

import type { Server } from "bun";
import type { Backend, Plan } from "../plan/service";
import type { JsonValue } from "../storage/model";
import type { SocketData } from "../wire";

const now = new Date("2026-08-13T12:00:00.000Z");

async function hosted() {
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_octocat", login: "octocat", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Implementation plan",
		createdBy: "U_octocat",
		now,
	});
	let lease = await storage.leases.acquire("writer", "graph-test", 60_000);
	if (!lease) throw new Error("could not acquire test lease");
	let backend: Backend = {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	};
	let server = { publish() {} } as unknown as Server<SocketData>;
	return { storage, channel, lease, backend, server };
}

const definition = {
	tasks: [{
		id: "model",
		title: "Model graphs",
		context: "The sidecar owns the graph.",
		goal: "Persist implementation work.",
		acceptance: ["The graph is durable.", "The plan remains MDX only."],
		dependsOn: [],
	}],
};

function run(planRevision: number, graphVersion = 1, id = "run-1") {
	return {
		id,
		user: "octocat",
		client: { name: "Codex", version: "1.2.3" },
		session: "session-1",
		planRevision,
		graphVersion,
		graphRevision: 1,
		repository: "octo-org/score",
		branch: "tq/017",
		commit: "deadbeef",
		startedAt: "2026-08-17T12:00:00.000Z",
	};
}

async function verifyRun(plan: Plan, runId: string) {
	for (
		let input of [
			{
				kind: "start" as const,
				runId,
				taskId: "model",
				idempotencyKey: `${runId}-start`,
			},
			{
				kind: "report_pr" as const,
				runId,
				taskId: "model",
				url: "https://github.com/octo-org/score/pull/49",
				state: "open" as const,
				idempotencyKey: `${runId}-pr`,
			},
			{
				kind: "complete" as const,
				runId,
				taskId: "model",
				summary: "The graph is durable.",
				idempotencyKey: `${runId}-complete`,
			},
			{
				kind: "report_verification" as const,
				runId,
				passed: true,
				summary: "The implementation passed review.",
				reviewerMethod: "Ran the focused implementation suite.",
				evidence: [{ taskId: "model", evidence: ["Focused suite passed."] }],
				tasksNeedingWork: [],
				idempotencyKey: `${runId}-verification`,
			},
		]
	) {
		expect(await reportImplementationLifecycle(plan, input)).toMatchObject({
			kind: "accepted",
		});
	}
}

describe("the plan graph adapter", () => {
	it("keeps implementation preparation policy with graph persistence", async () => {
		let context = await hosted();
		let plan = await open(context.channel.id, context.backend, context.server);
		let readiness = (graphPlans as typeof graphPlans & {
			implementationReadiness?: (plan: Plan, revision: unknown) => unknown;
		}).implementationReadiness;

		expect(readiness).toBeTypeOf("function");
		if (typeof readiness !== "function") return;

		plan.records.set("open", { id: "open", status: "open" } as never);
		plan.threads.set("accepted", { id: "accepted", status: "accepted", notes: [] } as never);
		expect(readiness(plan, -1)).toEqual({
			ok: false,
			blockers: [
				"unanswered questionnaires",
				"accepted comments awaiting plan changes",
				"invalid plan revision",
			],
		});

		plan.records.clear();
		plan.threads.clear();
		expect(readiness(plan, plan.revision)).toEqual({ ok: true, revision: plan.revision });
		await close(plan);
	});

	it("keeps a document graph in the hosted sidecar through a restart", async () => {
		let context = await hosted();
		let first = await open(context.channel.id, context.backend, context.server);

		let graph = await implementationGraphs().revise(first, {
			planRevision: 0,
			graphRevision: 0,
			operations: definition.tasks.map(task => ({ op: "add", task })),
		});
		expect(graph.ok).toBe(true);
		await close(first);
		let stored = await context.storage.collaboration.load(context.channel.id, now);
		expect(stored?.sidecar).toMatchObject({
			graph: { versions: [{ state: "draft", planRevision: 0, definition }] },
		});

		let restored = await open(context.channel.id, context.backend, context.server);
		expect(
			(await implementationGraphs().revise(restored, {
				planRevision: 0,
				graphRevision: 1,
				operations: [{ op: "replace", id: "model", task: definition.tasks[0] }],
			})).ok,
		).toBe(true);
		await close(restored);
	});

	it("ignores a malformed graph record while reopening the document", async () => {
		let context = await hosted();
		let first = await open(context.channel.id, context.backend, context.server);
		await close(first);
		let stored = await context.storage.collaboration.load(context.channel.id, now);
		if (
			!stored?.snapshot
			|| !stored.snapshot.sidecar
			|| typeof stored.snapshot.sidecar !== "object"
		) {
			throw new Error("channel was not initialized");
		}
		await context.storage.collaboration.commit({
			channelId: context.channel.id,
			lease: context.lease,
			expectedRevision: stored.channel.revision,
			operationId: "malformed-graph",
			epoch: stored.snapshot.epoch,
			sidecar: { ...stored.snapshot.sidecar, graph: {} } as JsonValue,
			events: [],
			now,
		});

		let restored = await open(context.channel.id, context.backend, context.server);
		expect(
			await implementationGraphs().revise(restored, {
				planRevision: 0,
				graphRevision: 0,
				operations: definition.tasks.map(task => ({ op: "add", task })),
			}),
		).toMatchObject({ ok: true });
		await close(restored);
	});

	it("restores only a run paired with the locked graph revision", async () => {
		let context = await hosted();
		let plan = await open(context.channel.id, context.backend, context.server);
		let drafted = await implementationGraphs().revise(plan, {
			planRevision: plan.revision,
			graphRevision: 0,
			operations: definition.tasks.map(task => ({ op: "add", task })),
		});
		expect(drafted.ok).toBe(true);
		expect((await implementationGraphs().approve(plan)).ok).toBe(true);
		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision),
			}),
		).toMatchObject({ kind: "started" });
		await close(plan);

		let stored = await context.storage.collaboration.load(context.channel.id, now);
		if (
			!stored?.snapshot || !stored.sidecar || typeof stored.sidecar !== "object"
			|| Array.isArray(stored.sidecar)
		) {
			throw new Error("claimed plan was not stored");
		}
		expect(stored.sidecar).toMatchObject({
			graph: { versions: [{ state: "locked" }] },
			execution: { graphRevision: 1 },
		});

		let restored = await open(context.channel.id, context.backend, context.server);
		expect(restored.execution?.id).toBe("run-1");
		await close(restored);

		let current = await context.storage.collaboration.load(context.channel.id, now);
		if (!current?.snapshot || !current.sidecar || typeof current.sidecar !== "object") {
			throw new Error("restored plan was not stored");
		}
		await context.storage.collaboration.commit({
			channelId: context.channel.id,
			lease: context.lease,
			expectedRevision: current.channel.revision,
			operationId: "mismatched-run",
			epoch: current.snapshot.epoch,
			sidecar: {
				...current.sidecar,
				execution: { ...run(0), graphRevision: 2 },
			} as JsonValue,
			events: [],
			now,
		});

		await expect(open(context.channel.id, context.backend, context.server))
			.rejects.toThrow("invalid implementation run");
	});

	it("rejects a locked graph without its execution while reopening", async () => {
		let context = await hosted();
		let plan = await open(context.channel.id, context.backend, context.server);
		expect(
			(await implementationGraphs().revise(plan, {
				planRevision: plan.revision,
				graphRevision: 0,
				operations: definition.tasks.map(task => ({ op: "add", task })),
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(plan)).ok).toBe(true);
		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision),
			}),
		).toMatchObject({ kind: "started" });
		await close(plan);

		let stored = await context.storage.collaboration.load(context.channel.id, now);
		let sidecar = stored?.sidecar;
		if (!stored?.snapshot || !sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) {
			throw new Error("claimed plan was not stored");
		}
		let { execution: _execution, ...withoutExecution } = sidecar;
		await context.storage.collaboration.commit({
			channelId: context.channel.id,
			lease: context.lease,
			expectedRevision: stored.channel.revision,
			operationId: "locked-without-execution",
			epoch: stored.snapshot.epoch,
			sidecar: withoutExecution as JsonValue,
			events: [],
			now,
		});

		await expect(open(context.channel.id, context.backend, context.server))
			.rejects.toThrow("invalid implementation lifecycle");
	});

	it("rejects an active execution for an already verified graph while reopening", async () => {
		let context = await hosted();
		let plan = await open(context.channel.id, context.backend, context.server);
		expect(
			(await implementationGraphs().revise(plan, {
				planRevision: plan.revision,
				graphRevision: 0,
				operations: definition.tasks.map(task => ({ op: "add", task })),
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(plan)).ok).toBe(true);
		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision),
			}),
		).toMatchObject({ kind: "started" });
		await verifyRun(plan, "run-1");
		await close(plan);

		let stored = await context.storage.collaboration.load(context.channel.id, now);
		let sidecar = stored?.sidecar;
		if (
			!stored?.snapshot || !sidecar || typeof sidecar !== "object"
			|| Array.isArray(sidecar)
		) {
			throw new Error("verified plan was not stored");
		}
		let graph = sidecar.graph;
		if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
			throw new Error("verified graph was not stored");
		}
		let versions = graph.versions;
		if (!Array.isArray(versions) || !versions[0] || typeof versions[0] !== "object") {
			throw new Error("verified graph version was not stored");
		}
		await context.storage.collaboration.commit({
			channelId: context.channel.id,
			lease: context.lease,
			expectedRevision: stored.channel.revision,
			operationId: "verified-graph-active-again",
			epoch: stored.snapshot.epoch,
			sidecar: {
				...sidecar,
				graph: {
					...graph,
					versions: [{ ...versions[0], state: "locked" }],
				},
				execution: run(0, 1, "run-2"),
			} as JsonValue,
			events: [],
			now,
		});

		await expect(open(context.channel.id, context.backend, context.server))
			.rejects.toThrow("invalid implementation lifecycle");
	});

	it("persists lifecycle activity before broadcasting implemented and delivered history", async () => {
		let report = (graphPlans as typeof graphPlans & {
			reportImplementationLifecycle?: (plan: Plan, input: unknown) => Promise<any>;
		}).reportImplementationLifecycle;
		expect(report).toBeTypeOf("function");
		if (!report) return;

		let context = await hosted();
		let frames: unknown[] = [];
		let server = {
			publish(_topic: string, frame: string) {
				frames.push(JSON.parse(frame));
			},
		} as unknown as Server<SocketData>;
		let plan = await open(context.channel.id, context.backend, server);
		expect(
			(await implementationGraphs().revise(plan, {
				planRevision: plan.revision,
				graphRevision: 0,
				operations: definition.tasks.map(task => ({ op: "add", task })),
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(plan)).ok).toBe(true);
		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision),
			}),
		).toMatchObject({ kind: "started" });

		expect(
			await report(plan, {
				kind: "start",
				runId: "run-1",
				taskId: "model",
				idempotencyKey: "start-model",
			}),
		).toMatchObject({ kind: "accepted" });
		expect(frames).toContainEqual(expect.objectContaining({
			kind: "plan:lifecycle",
			activity: expect.objectContaining({
				tasks: [{ id: "model", state: "in_progress" }],
			}),
		}));
		for (
			let input of [
				{
					kind: "report_pr" as const,
					runId: "run-1",
					taskId: "model",
					url: "https://github.com/octo-org/score/pull/49",
					state: "open" as const,
					idempotencyKey: "pr-model",
				},
				{
					kind: "complete" as const,
					runId: "run-1",
					taskId: "model",
					summary: "The graph is durable.",
					idempotencyKey: "complete-model",
				},
			]
		) {
			expect(await report(plan, input)).toMatchObject({ kind: "accepted" });
		}
		expect(
			await report(plan, {
				kind: "report_verification",
				runId: "run-1",
				passed: false,
				summary: "The model needs another pass.",
				reviewerMethod: "Ran the focused implementation suite.",
				evidence: [{ taskId: "model", evidence: ["One focused assertion failed."] }],
				tasksNeedingWork: ["model"],
				idempotencyKey: "verify-model-failed",
			}),
		).toMatchObject({ kind: "accepted" });
		expect(frames.at(-1)).toMatchObject({
			activity: {
				tasks: [{ id: "model", state: "in_progress" }],
				verification: { passed: false, tasksNeedingWork: ["model"] },
			},
			history: [],
		});
		expect(
			await report(plan, {
				kind: "complete",
				runId: "run-1",
				taskId: "model",
				summary: "The graph remains durable after rework.",
				idempotencyKey: "complete-model-rework",
			}),
		).toMatchObject({ kind: "accepted" });
		expect(
			await report(plan, {
				kind: "report_verification",
				runId: "run-1",
				passed: true,
				summary: "The implementation passed review.",
				reviewerMethod: "Ran the focused implementation suite.",
				evidence: [{ taskId: "model", evidence: ["Focused suite passed."] }],
				tasksNeedingWork: [],
				idempotencyKey: "verify-model",
			}),
		).toMatchObject({ kind: "accepted" });
		expect(frames.at(-1)).toMatchObject({
			kind: "plan:lifecycle",
			execution: { state: "idle" },
			history: [{
				outcome: { kind: "implemented" },
				progress: { verification: { passed: true } },
			}],
		});
		expect(frames.at(-1)).not.toHaveProperty("activity");
		expect(
			await report(plan, {
				kind: "report_pr",
				runId: "run-1",
				taskId: "model",
				url: "https://github.com/octo-org/score/pull/49",
				state: "merged",
				idempotencyKey: "merge-model",
			}),
		).toMatchObject({ kind: "accepted" });
		expect(frames.at(-1)).toMatchObject({
			kind: "plan:lifecycle",
			history: [{ outcome: { kind: "delivered" } }],
		});
		await close(plan);

		let restored = await open(context.channel.id, context.backend, context.server);
		expect(restored.execution).toBeUndefined();
		expect(restored.lifecycle).not.toHaveProperty("events");
		expect(restored.lifecycle.history[0]?.events.at(-1)).toEqual({
			kind: "report_pr",
			taskId: "model",
			url: "https://github.com/octo-org/score/pull/49",
			state: "merged",
			idempotencyKey: "merge-model",
		});
		expect(restored.lifecycle.history[0]?.events.some(event => "runId" in event)).toBe(false);
		await close(restored);
	});

	it("rolls a failed lifecycle commit back before broadcasting", async () => {
		let context = await hosted();
		let frames: unknown[] = [];
		let server = {
			publish(_topic: string, frame: string) {
				frames.push(JSON.parse(frame));
			},
		} as unknown as Server<SocketData>;
		let plan = await open(context.channel.id, context.backend, server);
		expect(
			(await implementationGraphs().revise(plan, {
				planRevision: plan.revision,
				graphRevision: 0,
				operations: definition.tasks.map(task => ({ op: "add", task })),
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(plan)).ok).toBe(true);
		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision),
			}),
		).toMatchObject({ kind: "started" });
		for (
			let input of [
				{
					kind: "start" as const,
					runId: "run-1",
					taskId: "model",
					idempotencyKey: "rollback-start",
				},
				{
					kind: "report_pr" as const,
					runId: "run-1",
					taskId: "model",
					url: "https://github.com/octo-org/score/pull/49",
					state: "open" as const,
					idempotencyKey: "rollback-pr",
				},
				{
					kind: "complete" as const,
					runId: "run-1",
					taskId: "model",
					summary: "Ready to verify.",
					idempotencyKey: "rollback-complete",
				},
			]
		) {
			expect(await reportImplementationLifecycle(plan, input)).toMatchObject({
				kind: "accepted",
			});
		}
		let before = {
			graph: plan.graph,
			execution: plan.execution,
			lifecycle: plan.lifecycle,
			frames: frames.length,
		};
		let original = context.storage.collaboration.commit;
		(context.storage.collaboration as { commit: typeof original }).commit = async () => {
			throw new Error("storage unavailable");
		};

		expect(
			await reportImplementationLifecycle(plan, {
				kind: "report_verification",
				runId: "run-1",
				passed: true,
				summary: "The implementation passed review.",
				reviewerMethod: "Ran the focused implementation suite.",
				evidence: [{ taskId: "model", evidence: ["Focused suite passed."] }],
				tasksNeedingWork: [],
				idempotencyKey: "rollback-verification",
			}),
		).toEqual({ kind: "refused", reason: "durability" });
		expect(plan.graph).toBe(before.graph);
		expect(plan.execution).toBe(before.execution);
		expect(plan.lifecycle).toBe(before.lifecycle);
		expect(frames).toHaveLength(before.frames);
		expect(plan.lifecycle.events?.some(event => event.kind === "report_verification")).toBe(false);
		(context.storage.collaboration as { commit: typeof original }).commit = original;
		await close(plan);
	});

	it("refuses a verified graph but claims a new graph version with reused revisions", async () => {
		let context = await hosted();
		let plan = await open(context.channel.id, context.backend, context.server);
		expect(
			(await implementationGraphs().revise(plan, {
				planRevision: plan.revision,
				graphRevision: 0,
				operations: definition.tasks.map(task => ({ op: "add", task })),
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(plan)).ok).toBe(true);
		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision),
			}),
		).toMatchObject({ kind: "started" });
		await verifyRun(plan, "run-1");

		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision, 1, "run-2"),
			}),
		).toEqual({ kind: "refused", reason: "already-verified" });

		expect(
			(await implementationGraphs().revise(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				operations: [{ op: "replace", id: "model", task: definition.tasks[0] }],
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(plan)).ok).toBe(true);
		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision, 2, "run-2"),
			}),
		).toMatchObject({ kind: "started" });
		await close(plan);
	});

	it("refuses an archived revision run id before claiming live work", async () => {
		let context = await hosted();
		let plan = await open(context.channel.id, context.backend, context.server);
		expect(
			(await implementationGraphs().revise(plan, {
				planRevision: plan.revision,
				graphRevision: 0,
				operations: definition.tasks.map(task => ({ op: "add", task })),
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(plan)).ok).toBe(true);
		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision),
			}),
		).toMatchObject({ kind: "started" });
		expect(
			await reportImplementationLifecycle(plan, {
				kind: "request_revision",
				runId: "run-1",
				reason: "The graph needs another pass.",
				idempotencyKey: "revise-run-1",
			}),
		).toMatchObject({ kind: "accepted" });

		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision),
			}),
		).toEqual({ kind: "refused", reason: "run" });
		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision, 1, "run-2"),
			}),
		).toMatchObject({ kind: "started" });
		await close(plan);
	});

	it("refuses an archived revision run id before preparing a stored claim", async () => {
		let context = await hosted();
		let plan = await open(context.channel.id, context.backend, context.server);
		expect(
			(await implementationGraphs().revise(plan, {
				planRevision: plan.revision,
				graphRevision: 0,
				operations: definition.tasks.map(task => ({ op: "add", task })),
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(plan)).ok).toBe(true);
		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision),
			}),
		).toMatchObject({ kind: "started" });
		expect(
			await reportImplementationLifecycle(plan, {
				kind: "request_revision",
				runId: "run-1",
				reason: "The graph needs another pass.",
				idempotencyKey: "revise-run-1",
			}),
		).toMatchObject({ kind: "accepted" });
		await close(plan);

		let stored = await context.storage.collaboration.load(context.channel.id, now);
		if (!stored) throw new Error("released plan was not stored");
		expect(claimStored(stored, {
			planRevision: 0,
			graphRevision: 1,
			run: run(0),
		})).toEqual({ result: { kind: "refused", reason: "run" } });
		expect(claimStored(stored, {
			planRevision: 0,
			graphRevision: 1,
			run: run(0, 1, "run-2"),
		})).toMatchObject({ result: { kind: "started" }, sidecar: {} });
	});
});

describe("living-document builds", () => {
	const buildId = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

	async function builtPlan(
		liveBuild: boolean,
		ending: "complete" | "block" | "unreported" = "complete",
	) {
		let context = await hosted();
		context.backend.liveBuild = liveBuild;
		let plan = await open(context.channel.id, context.backend, context.server);
		expect(
			(await implementationGraphs().revise(plan, {
				planRevision: plan.revision,
				graphRevision: 0,
				operations: definition.tasks.map(task => ({ op: "add", task })),
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(plan)).ok).toBe(true);
		plan.builds = [{
			id: buildId,
			user: "octocat",
			connectionId: "connection-1",
			repositoryId: "R_score",
			checkout: { repository: "octo-org/score", branch: "main", commit: "a".repeat(40) },
			planRevision: plan.revision,
			graphVersion: 1,
			graphRevision: 1,
			createdAt: now.toISOString(),
			expiresAt: now.getTime() + 60_000,
			state: "running",
			session: "session-1",
		}];
		expect(
			await claimImplementation(plan, {
				planRevision: plan.revision,
				graphRevision: 1,
				run: run(plan.revision, 1, buildId),
			}),
		).toMatchObject({ kind: "started" });
		let inputs = [
			{ kind: "start" as const, taskId: "model", idempotencyKey: "start" },
			...(ending === "unreported" ? [] : [{
				kind: "report_pr" as const,
				taskId: "model",
				url: "https://github.com/octo-org/score/pull/49",
				state: "open" as const,
				idempotencyKey: "pr",
			}]),
			ending === "complete"
				? {
					kind: "complete" as const,
					taskId: "model",
					summary: "The graph is durable.",
					idempotencyKey: "complete",
				}
				: {
					kind: "block" as const,
					taskId: "model",
					reason: "Which storage engine should the graph use?",
					idempotencyKey: "block",
				},
		];
		for (let input of inputs) {
			expect(await reportImplementationLifecycle(plan, { ...input, runId: buildId }))
				.toMatchObject({ kind: "accepted" });
		}
		return { context, plan };
	}

	it("snapshots the built source when the last task completes", async () => {
		let { context, plan } = await builtPlan(true);
		expect(plan.execution).toBeUndefined();
		expect(plan.live).toEqual({
			buildId,
			user: "octocat",
			repositoryId: "R_score",
			checkout: { repository: "octo-org/score", branch: "main", commit: "a".repeat(40) },
			baseRevision: plan.revision,
			baseSource: source(plan),
			pullRequests: ["https://github.com/octo-org/score/pull/49"],
		});
		plan.builds = [{ ...plan.builds[0]!, state: "stopped" }];
		expect(implementationActive(plan)).toBe(false);
		let live = plan.live;
		await close(plan);

		let restored = await open(context.channel.id, context.backend, context.server);
		expect(restored.live).toEqual(live);
		expect(restored.execution).toBeUndefined();
		expect(
			await reportImplementationLifecycle(restored, {
				kind: "report_pr",
				runId: buildId,
				taskId: "model",
				url: "https://github.com/octo-org/score/pull/49",
				state: "merged",
				idempotencyKey: "merged",
			}),
		).toMatchObject({ kind: "accepted" });
		await close(restored);
	});

	it("goes live from a first build that stops with a blocked task", async () => {
		let { context, plan } = await builtPlan(true, "block");
		expect(plan.live).toBeUndefined();
		await reportBuild(plan, "octocat", "connection-1", buildId, { state: "stopped" });
		expect(plan.execution).toBeUndefined();
		expect(plan.live).toEqual({
			buildId,
			user: "octocat",
			repositoryId: "R_score",
			checkout: { repository: "octo-org/score", branch: "main", commit: "a".repeat(40) },
			baseRevision: plan.revision,
			baseSource: source(plan),
			pullRequests: ["https://github.com/octo-org/score/pull/49"],
			outstanding: ["model"],
		});
		expect(plan.lifecycle.history.at(-1)).toMatchObject({ run: { id: buildId }, live: true });
		expect(implementationActive(plan)).toBe(false);
		await close(plan);

		let restored = await open(context.channel.id, context.backend, context.server);
		expect(restored.live?.outstanding).toEqual(["model"]);
		let rebuildId = crypto.randomUUID();
		restored.builds = [...restored.builds, {
			...restored.builds[0]!,
			id: rebuildId,
			kind: "rebuild",
			baseRevision: restored.revision,
			targetRevision: restored.revision,
			state: "running",
		}];
		restored.live = {
			...restored.live!,
			target: { buildId: rebuildId, revision: restored.revision, source: source(restored) },
		};
		expect((await readRebuild(restored, rebuildId))?.outstanding).toEqual([{
			id: "model",
			title: "Model graphs",
			goal: "Persist implementation work.",
			acceptance: ["The graph is durable.", "The plan remains MDX only."],
			state: "blocked",
			blocker: "Which storage engine should the graph use?",
			pullRequest: "https://github.com/octo-org/score/pull/49",
		}]);
		let task = {
			title: "Finish graph storage",
			goal: "Persist implementation work.",
			pullRequest: "https://github.com/octo-org/score/pull/50",
		};
		expect(
			await reportRebuild(restored, rebuildId, {
				summary: "Finished.",
				commits: [],
				tasks: [task],
			}),
		).toEqual({ kind: "refused", reason: "pull-request" });
		expect(
			await reportRebuild(restored, rebuildId, {
				summary: "Finished the blocked graph storage task.",
				commits: [{
					pullRequest: "https://github.com/octo-org/score/pull/49",
					sha: "c".repeat(40),
					message: "Store graphs in PostgreSQL",
				}],
				tasks: [{ ...task, pullRequest: "https://github.com/octo-org/score/pull/49" }],
			}),
		).toEqual({ kind: "accepted" });
		expect(restored.live?.outstanding).toBeUndefined();
		await close(restored);
	});

	it("lets an outstanding task without a pull request open one during a rebuild", async () => {
		let { plan } = await builtPlan(true, "block");
		await reportBuild(plan, "octocat", "connection-1", buildId, { state: "failed" });
		expect(plan.live?.outstanding).toEqual(["model"]);
		// As if the blocked task had never reported its pull request.
		let archived = plan.lifecycle.history.at(-1)!;
		archived.events = archived.events.filter(event => event.kind !== "report_pr");
		let rebuildId = crypto.randomUUID();
		plan.builds = [...plan.builds, {
			...plan.builds[0]!,
			id: rebuildId,
			kind: "rebuild",
			baseRevision: plan.revision,
			targetRevision: plan.revision,
			state: "running",
		}];
		plan.live = {
			...plan.live!,
			target: { buildId: rebuildId, revision: plan.revision, source: source(plan) },
		};
		let task = { title: "Finish graph storage", goal: "Persist implementation work." };
		let report = (urls: string[]) =>
			reportRebuild(plan, rebuildId, {
				summary: "Opened the missing pull request.",
				commits: [],
				tasks: urls.map(url => ({ ...task, pullRequest: url })),
			});
		expect(
			await report([
				"https://github.com/octo-org/score/pull/50",
				"https://github.com/octo-org/score/pull/51",
			]),
		).toEqual({ kind: "refused", reason: "pull-request" });
		expect(await report(["https://github.com/other/score/pull/50"]))
			.toEqual({ kind: "refused", reason: "pull-request" });
		expect(await report(["https://github.com/octo-org/score/pull/50"]))
			.toEqual({ kind: "accepted" });
		expect(plan.live?.pullRequests).toEqual([
			"https://github.com/octo-org/score/pull/49",
			"https://github.com/octo-org/score/pull/50",
		]);
		await close(plan);
	});

	it("stays unbuilt when a stopped first build opened no pull request", async () => {
		let { plan } = await builtPlan(true, "unreported");
		await reportBuild(plan, "octocat", "connection-1", buildId, { state: "stopped" });
		expect(plan.live).toBeUndefined();
		expect(plan.execution?.id).toBe(buildId);
		await close(plan);
	});

	it("keeps the verified lifecycle when live builds are off", async () => {
		let { plan } = await builtPlan(false);
		expect(plan.live).toBeUndefined();
		expect(plan.execution?.id).toBe(buildId);
		expect(implementationActive(plan)).toBe(true);
		await close(plan);
	});

	it("rejects a sidecar whose live record names another build", async () => {
		let { context, plan } = await builtPlan(true);
		await close(plan);
		let stored = await context.storage.collaboration.load(context.channel.id, now);
		if (!stored?.snapshot || !stored.sidecar || typeof stored.sidecar !== "object") {
			throw new Error("live plan was not stored");
		}
		let sidecar = stored.sidecar as Record<string, JsonValue>;
		await context.storage.collaboration.commit({
			channelId: context.channel.id,
			lease: context.lease,
			expectedRevision: stored.channel.revision,
			operationId: "foreign-live-build",
			epoch: stored.snapshot.epoch,
			sidecar: {
				...sidecar,
				live: { ...(sidecar.live as Record<string, JsonValue>), buildId: crypto.randomUUID() },
			},
			events: [],
			now,
		});
		await expect(open(context.channel.id, context.backend, context.server))
			.rejects.toThrow("invalid live build");
	});
});
