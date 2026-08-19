import { describe, expect, it } from "bun:test";

import * as graphPlans from "./plan-graphs";
import {
	claimImplementation,
	implementationGraphs,
	reportImplementationLifecycle,
} from "./plan-graphs";
import { MemoryStorage } from "../storage/memory/adapter";
import { claimStored, close, open } from "../plan/service";

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
