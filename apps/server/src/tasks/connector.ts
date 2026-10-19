import { z } from "zod";
import { serves } from "../experiments/connections";
import type { Connection, Connections, Grant } from "../experiments/connections";
import { ExperimentError } from "@chopin/experiment";
import { fail } from "../experiments/service";
import { LIFECYCLE_TOOLS, lifecycleCall } from "../mcp/lifecycle";
import { exclusive, source } from "../plan/service";
import type { Plan } from "../plan/service";
import type { BuildRequest } from "@chopin/protocol/implementation";
import { claimImplementation, reportImplementationLifecycle } from "./plan-graphs";
import {
	pickBuild,
	readRebuild,
	rebindBuild,
	rebuildReportSchema,
	renewQueued,
	reportBuild,
	reportRebuild,
} from "./builds";
import { implementationLifecycle } from "./lifecycle";

/** Why a build claimed before the server restarted ended: the server forgot it. */
export const RESTARTED = "Chopin restarted, so this build ended.";
/** A connection ended and its machine has no other: the connector disconnected or was stopped. */
export const DISCONNECTED = "Your local agent disconnected.";
/** The build's heartbeat stopped while its machine may still be connected. */
export const UNRESPONSIVE = "Your local agent stopped responding.";

export type WithPlan = <T>(id: string, action: (plan: Plan) => Promise<T>) => Promise<T>;

export function implementationSchemas(
	runScoped: boolean,
	rebuild = false,
): Record<string, z.ZodType<Record<string, unknown>>> {
	if (!runScoped) {
		let id = z.string().uuid();
		return {
			// Protocol 4: with `planners`, the connector's Planner poll, naming the documents whose
			// Planners it runs; it is answered only with what it should run, never with work.
			wait_for_work: z.object({
				planners: z.array(z.string().min(1).max(100)).max(64).optional(),
			}).strict(),
			claim_implementation_build: z.object({ id }).strict(),
			renew_implementation_build: z.object({
				id,
				documentId: id.optional(),
				progress: z.string().min(1).max(2000).optional(),
			}).strict(),
			report_implementation_build: z.object({
				id,
				documentId: id.optional(),
				state: z.enum(["running", "stopped", "failed"]),
				session: z.string().min(1).max(128).optional(),
				error: z.string().max(2000).optional(),
				/** Kept across the connector's retries of one report, so a repeat is recognized. */
				idempotencyKey: z.string().uuid().optional(),
			}).strict(),
		};
	}
	if (rebuild) {
		return { read_rebuild: z.object({}).strict(), report_rebuild: rebuildReportSchema };
	}
	return {
		read_implementation: z.object({}).strict(),
		...Object.fromEntries(LIFECYCLE_TOOLS.map(tool => {
			let { id: _id, runId: _run, ...properties } = tool.inputSchema.properties;
			return [
				tool.name,
				z.fromJSONSchema({
					...tool.inputSchema,
					type: "object" as const,
					properties: JSON.parse(JSON.stringify(properties)),
					required: tool.inputSchema.required.filter(key => key !== "id" && key !== "runId"),
				}) as z.ZodType<Record<string, unknown>>,
			];
		})),
	};
}

/**
 * Next steps for a lifecycle refusal a coding agent can fix. `retry` marks refusals that a parallel
 * call in the same batch may still resolve, so the server retries them before answering.
 */
const REFUSALS: Record<string, Record<string, { retry?: true; advice: string }>> = {
	start_task: {
		dependency: {
			retry: true,
			advice:
				"A task this one depends on is not complete. Finish it with report_pr then complete_task, and retry start_task with the same idempotencyKey.",
		},
		"task-state": {
			advice:
				"The task is already in progress or completed. Continue with report_pr and complete_task.",
		},
	},
	block_task: {
		"task-state": {
			advice:
				"The task is already blocked or completed. Call start_task to resume a blocked task before blocking it again.",
		},
	},
	report_pr: {
		"task-state": {
			retry: true,
			advice:
				"The task has not started. Call start_task for it, then retry report_pr with the same idempotencyKey.",
		},
		"pull-request": {
			advice:
				"report_pr needs the pull request's full GitHub URL and a state of open, merged or closed. Fix the arguments and retry.",
		},
	},
	complete_task: {
		"already-complete": {
			advice:
				"The task is already complete. Nothing more to report for it; move on to the next task.",
		},
		"pull-request": {
			retry: true,
			advice:
				"The task has no pull request yet. Call report_pr for it, wait for that call to finish, then retry complete_task with the same idempotencyKey.",
		},
		"task-state": {
			retry: true,
			advice:
				"The task is not in progress. Call start_task (and report_pr) for it, then retry complete_task with the same idempotencyKey.",
		},
	},
};

export function implementationConnector(
	withPlan: WithPlan,
	connections: Connections,
	documentUrl: (id: string) => Promise<string>,
	documentExists: (id: string) => Promise<boolean>,
	/** Whether a prototype is executing on a connection; a build queued behind it waits. */
	prototyping?: (connectionId: string) => Promise<boolean>,
	options: { retryMs?: number; retries?: number } = {},
) {
	let tracked = new Set<string>();
	// Lifecycle calls of one run apply in arrival order, one at a time.
	let chains = new Map<string, Promise<unknown>>();
	let serial = <T>(key: string, action: () => Promise<T>): Promise<T> => {
		let operation = (chains.get(key) ?? Promise.resolve()).then(action, action);
		let settled = operation.catch(() => {});
		chains.set(key, settled);
		void settled.then(() => {
			if (chains.get(key) === settled) chains.delete(key);
		});
		return operation;
	};
	/** The connection's current build; a finished one hands over to the next queued document. */
	let pending = async (connection: Connection) => {
		// Bounded by the queue: each pass releases one document.
		for (let pass = 0; pass <= 100; pass++) {
			let documentId = connections.assigned(connection.id);
			if (!documentId) return undefined;
			try {
				let build = await documentExists(documentId)
					? await withPlan(documentId, async plan => {
						let build = plan.builds.at(-1);
						return build?.connectionId === connection.id && build.user === connection.owner
							? build
							: undefined;
					})
					: undefined;
				if (build && ["queued", "starting", "running"].includes(build.state)) return build;
				connections.release(connection.id, documentId);
			} catch {
				return undefined;
			}
		}
	};
	let api = {
		track(id: string) {
			tracked.add(id);
		},
		async waiting(connection: Connection) {
			let build = await pending(connection);
			return build?.state === "queued"
				? { id: build.id, kind: "implementation" as const }
				: undefined;
		},
		async busy(connection: Connection) {
			let build = await pending(connection);
			return !!build && ["queued", "starting", "running"].includes(build.state);
		},
		/**
		 * Agents often send start_task, report_pr and complete_task in one parallel batch. Serializing
		 * them per run and briefly retrying order-dependent refusals lets the batch land in order.
		 */
		async call(connection: Connection, grant: Grant, name: string, args: Record<string, unknown>) {
			let run = grant.run;
			if (!run || !LIFECYCLE_TOOLS.some(tool => tool.name === name)) {
				return api.invoke(connection, grant, name, args);
			}
			let retries = options.retries ?? 4;
			for (let attempt = 0;; attempt++) {
				try {
					return await serial(run.id, () => api.invoke(connection, grant, name, args));
				} catch (error) {
					let refusal = error instanceof ExperimentError ? REFUSALS[name]?.[error.code] : undefined;
					if (!refusal) throw error;
					if (refusal.retry && attempt < retries) {
						await new Promise(resolve => setTimeout(resolve, options.retryMs ?? 250));
						continue;
					}
					fail((error as ExperimentError).code, refusal.advice);
				}
			}
		},
		/**
		 * The document a connector call is about: its run credential's, the run this process handed
		 * out under that build id, or the build its connection was given.
		 */
		document(connection: Connection, grant: Grant, name: string, args: Record<string, unknown>) {
			let runId = typeof args.id === "string" && name !== "claim_implementation_build"
				? args.id
				: undefined;
			return grant.run?.documentId ?? args.documentId as string | undefined
				?? (runId && connections.runDocument(runId))
				?? connections.assigned(connection.id);
		},
		/** One connector call, unserialized. */
		async invoke(
			connection: Connection,
			grant: Grant,
			name: string,
			args: Record<string, unknown>,
		) {
			let runId = grant.run?.id ?? (typeof args.id === "string" ? args.id : undefined);
			let caller = `connection ${connection.id} of machine ${connection.machineId}`;
			let documentId = api.document(connection, grant, name, args);
			if (!documentId) {
				// A build this process never handed out was claimed before Chopin restarted, which
				// forgot every connection and run with it.
				if (runId && !grant.run && name !== "claim_implementation_build") {
					console.warn(
						`chopin: refused ${name} for build ${runId} from ${caller} - server-restarted`,
					);
					fail("server-restarted", RESTARTED);
				}
				console.warn(`chopin: refused ${name} from ${caller} - build-forbidden, no build`);
				fail("build-forbidden");
			}
			tracked.add(documentId);
			return withPlan(documentId, async plan => {
				function refuse(code: string, build?: BuildRequest, message?: string): never {
					console.warn(
						`chopin: refused ${name} for build ${runId ?? "none"} of document ${plan.id} from `
							+ `${caller} - ${code}`
							+ (build
								? `; build ${build.id} is ${build.state} on connection ${build.connectionId} `
									+ `of machine ${build.machineId ?? "unknown"}`
								: ""),
					);
					fail(code, message);
				}
				// Only a landed report stops a rebuild, so a retried report after that is the same
				// success, even once a newer rebuild has queued behind it.
				if (grant.run?.kind === "rebuild" && name === "report_rebuild") {
					let own = plan.builds.find(item => item.id === grant.run!.id);
					if (
						own?.kind === "rebuild" && own.state === "stopped" && grant.run.generation === 1
						&& own.connectionId === connection.id && own.user === connection.owner
					) {
						let report = rebuildReportSchema.safeParse(args);
						if (!report.success) fail("invalid-request");
						// The same report: its tasks landed as a live run, or its commits are recorded.
						let commits = plan.live?.commits ?? [];
						if (
							plan.lifecycle.history.some(item => item.run.id === own.id)
							|| report.data.commits.every(commit =>
								commits.some(item =>
									item.sha === commit.sha.toLowerCase()
									&& item.pullRequest.toLowerCase() === commit.pullRequest.toLowerCase()
								)
							)
						) return { state: "stopped" };
						fail("build-inactive");
					}
				}
				// Cleanup may release this assignment or queue another build before the agent finishes.
				// Only a landed rebuild accepts the controller's late renewal or successful exit.
				if (
					!grant.run && (name === "renew_implementation_build"
						|| name === "report_implementation_build" && args.state === "stopped")
				) {
					let own = plan.builds.find(item => item.id === args.id);
					if (
						own?.kind === "rebuild" && own.state === "stopped"
						&& own.connectionId === connection.id && own.user === connection.owner
						&& serves(connection, own.repositoryId)
					) {
						return name === "renew_implementation_build"
							? { accepted: true, state: "stopped" }
							: { accepted: true };
					}
				}
				let build = plan.builds.at(-1);
				// A document hint survives restart; it must not revive a forgotten connection.
				if (build && !grant.run && build.id === args.id && !connections.known(build.connectionId)) {
					refuse("server-restarted", build, RESTARTED);
				}
				// The connector registered its machine again, as after a dropped request, so the build's
				// heartbeat and reports now come on a newer connection of the same machine and owner.
				if (
					build && !grant.run && build.connectionId !== connection.id && build.id === args.id
					&& build.machineId === connection.machineId && build.user === connection.owner
					&& serves(connection, build.repositoryId)
					&& ["renew_implementation_build", "report_implementation_build"].includes(name)
					&& ["starting", "running"].includes(build.state) && build.expiresAt > Date.now()
				) {
					let from = build.connectionId;
					if (await rebindBuild(plan, build.id, from, connection.id)) {
						connections.rebind(from, connection, plan.id, build.id);
						console.info(
							`chopin: build ${build.id} of document ${plan.id} moved from connection ${from} `
								+ `to ${connection.id} of machine ${connection.machineId}, which registered `
								+ `again; ${name} continues it`,
						);
						build = plan.builds.at(-1)!;
					}
				}
				if (!grant.run && connections.assigned(connection.id) !== documentId) {
					refuse("build-forbidden", build);
				}
				if (
					!build || build.connectionId !== connection.id || build.user !== connection.owner
					|| !serves(connection, build.repositoryId)
					|| build.id !== (grant.run?.id ?? args.id)
				) refuse("build-forbidden", build);
				if (grant.run) {
					let rebuild = build.kind === "rebuild";
					if (
						grant.run.kind !== (rebuild ? "rebuild" : "implementation")
						|| grant.run.generation !== 1
						|| build.state !== "running" || build.expiresAt <= Date.now()
					) refuse("build-inactive", build);
					if (rebuild) {
						if (name === "read_rebuild") {
							return await readRebuild(plan, build.id) ?? fail("build-inactive");
						}
						if (name !== "report_rebuild") fail("tool-forbidden");
						let report = rebuildReportSchema.safeParse(args);
						if (!report.success) fail("invalid-request");
						let result = await reportRebuild(plan, build.id, report.data);
						if (result.kind === "refused") fail(result.reason);
						return { state: "stopped" };
					}
					if (name === "read_implementation") {
						return exclusive(plan, async () => ({
							document: {
								id: plan.id,
								revision: plan.revision,
								source: source(plan),
								url: await documentUrl(plan.id),
							},
							graph: plan.graph?.versions.at(-1),
							run: plan.execution
								?? plan.lifecycle.history.find(item => item.run.id === build.id)?.run,
							...implementationLifecycle({
								graph: plan.graph!,
								execution: plan.execution,
								lifecycle: plan.lifecycle,
							}),
						}));
					}
					let parsed = lifecycleCall(name, { ...args, id: plan.id, runId: build.id });
					if (!parsed.known || !parsed.input) fail("invalid-request");
					let result = await reportImplementationLifecycle(plan, parsed.input);
					if (result.kind === "refused") fail(result.reason);
					return { state: result.kind };
				}
				if (name === "claim_implementation_build") {
					if (build.expiresAt <= Date.now()) fail("build-expired");
					let picked = await pickBuild(plan, connection.owner, connection.id);
					if (!picked) fail("build-already-claimed");
					return {
						build: picked,
						// A first build of a living document ends at its last complete_task.
						live: picked.kind !== "rebuild" && !!plan.persistence.liveBuild && !plan.live,
						documentId: plan.id,
						source: { ...picked.checkout, repositoryId: picked.repositoryId },
						runToken: connections.runToken(
							connection.id,
							plan.id,
							picked.id,
							1,
							picked.kind === "rebuild" ? "rebuild" : "implementation",
						),
					};
				}
				// A report whose answer was lost comes again with the same key; the build already shows it.
				if (
					name === "report_implementation_build" && args.idempotencyKey !== undefined
					&& build.reportKey === args.idempotencyKey
				) {
					return { accepted: true };
				}
				if (!["starting", "running"].includes(build.state) || build.expiresAt <= Date.now()) {
					refuse("build-inactive", build);
				}
				if (name === "renew_implementation_build") {
					await reportBuild(plan, connection.owner, connection.id, build.id, {
						state: build.state as "running" | "starting",
						expiresAt: Date.now() + 60_000,
						progress: args.progress as string | undefined,
					});
				} else if (name === "report_implementation_build") {
					let { documentId: _document, idempotencyKey: reportKey, ...sent } = args as {
						documentId?: string;
						state: "running" | "stopped" | "failed";
						session?: string;
						error?: string;
						idempotencyKey?: string;
					};
					let report: typeof sent & { reportKey?: string } = { ...sent, reportKey };
					if (build.kind === "rebuild" && report.state === "stopped") {
						// Only report_rebuild lands a rebuild; ending without it leaves the live base alone.
						report = {
							state: "failed",
							error: "The agent finished without reporting the rebuild.",
							reportKey,
						};
					}
					if (report.state === "running") {
						if (!report.session || build.state !== "starting") fail("invalid-state");
					}
					// A rebuild leaves the document open, so it never claims or locks the graph.
					if (report.state === "running" && report.session && build.kind !== "rebuild") {
						let claim = await claimImplementation(plan, {
							planRevision: build.planRevision,
							graphRevision: build.graphRevision,
							run: {
								id: build.id,
								user: connection.owner,
								client: { name: "chopin-acp", version: "0.1.0" },
								session: report.session,
								graphVersion: build.graphVersion,
								graphRevision: build.graphRevision,
								planRevision: build.planRevision,
								repository: build.checkout.repository,
								branch: `chopin/implement-${build.id.slice(0, 8)}`,
								commit: build.checkout.commit,
								startedAt: new Date().toISOString(),
							},
						});
						if (claim.kind !== "started") fail("build-claim-refused");
					}
					await reportBuild(plan, connection.owner, connection.id, build.id, report);
				} else fail("tool-forbidden");
				return { accepted: true };
			});
		},
		/**
		 * A connector that says it is leaving ends its builds now, persisted before they are announced.
		 * The sweep still catches a connector that was killed without saying so.
		 */
		async disconnected(connectionId: string) {
			for (let id of tracked) {
				if (!await documentExists(id)) continue;
				await withPlan(id, async plan => {
					let build = plan.builds.at(-1);
					if (
						build?.connectionId !== connectionId
						|| !["queued", "starting", "running"].includes(build.state)
					) return;
					await reportBuild(plan, build.user, connectionId, build.id, {
						state: "failed",
						error: DISCONNECTED,
					});
					connections.release(connectionId, id);
					tracked.delete(id);
				});
			}
		},
		async sweep() {
			for (let id of tracked) {
				if (!await documentExists(id)) {
					tracked.delete(id);
					continue;
				}
				await withPlan(id, async plan => {
					let build = plan.builds.at(-1);
					if (!build || !["queued", "starting", "running"].includes(build.state)) {
						if (build) connections.release(build.connectionId, id);
						tracked.delete(id);
						return;
					}
					let connected = !!connections.get(build.connectionId);
					// Queued behind another document's build on the same connection.
					let behind = connections.assigned(build.connectionId) !== id
						&& connections.queued(build.connectionId).includes(id);
					if (
						connected && build.state === "queued"
						&& (behind || await prototyping?.(build.connectionId))
					) {
						await renewQueued(plan, build.id);
						return;
					}
					if (!connected || build.expiresAt <= Date.now()) {
						// Say what happened: Chopin restarted since the build's connection opened, the
						// machine is gone, or its agent went quiet while the machine stayed connected.
						let error = connected
							? UNRESPONSIVE
							: !connections.known(build.connectionId)
							? RESTARTED
							: build.machineId && connections.machine(build.machineId).length
							? UNRESPONSIVE
							: DISCONNECTED;
						console.warn(
							`chopin: build ${build.id} of document ${id} on connection ${build.connectionId} `
								+ `of machine ${build.machineId ?? "unknown"} ended - ${error}`,
						);
						await reportBuild(plan, build.user, build.connectionId, build.id, {
							state: "failed",
							error,
						});
						connections.release(build.connectionId, id);
						tracked.delete(id);
					}
				});
			}
		},
	};
	return api;
}
export type ImplementationConnector = ReturnType<typeof implementationConnector>;
