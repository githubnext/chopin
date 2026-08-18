import { describe, expect, it } from "bun:test";

import * as graphPlans from "./plan-graphs";
import { claimImplementation, implementationGraphs } from "./plan-graphs";
import { MemoryStorage } from "../storage/memory/adapter";
import { close, open } from "../plan/service";

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

function run(planRevision: number) {
	return {
		id: "run-1",
		user: "octocat",
		client: { name: "Codex", version: "1.2.3" },
		session: "session-1",
		planRevision,
		graphRevision: 1,
		repository: "octo-org/score",
		branch: "tq/017",
		commit: "deadbeef",
		startedAt: "2026-08-17T12:00:00.000Z",
	};
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
		if (!stored?.snapshot || !stored.sidecar || typeof stored.sidecar !== "object") {
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

	it("persists lifecycle activity before broadcasting it", async () => {
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
		await close(plan);

		let restored = await open(context.channel.id, context.backend, context.server);
		expect(restored.lifecycle.events).toEqual([{
			kind: "start",
			taskId: "model",
			idempotencyKey: "start-model",
		}]);
		await close(restored);
	});
});
