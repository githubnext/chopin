/**
 * Shared build-start orchestration used by browser HTTP implementation routes, MCP `build_plan`,
 * and `orchestrate build`.
 *
 * Enforces one canonical admission order and mutual exclusion invariant:
 *   1. Top-level, unarchived document check.
 *   2. Active build check first (idempotent `already-building` for same user & revision, else
 *      `implementation-active`).
 *   3. Optional `planRevision` fence.
 *   4. Optional `requireSettledDecisions` gate (default `false` for browser Build parity).
 *   5. Plan readiness blockers (accepted comments, required investigations).
 *   6. Optional `rebuild` path on delivered living documents.
 *   7. Graph currency check (current graph -> queue build; missing/stale -> optional draft +
 *      server-side auto-queue with atomic mutual exclusion and cleanup on failure/refusal).
 *   8. Machine availability, checkout resolution, connection lock, and durable `queueBuild`.
 */

import { buildActive, queueBuild, queueRebuild, requestBuild } from "./builds";
import { claimEligibility } from "./lifecycle";
import { unapprovedDecisions } from "./open-decisions";
import { planningReadiness } from "./plan-graphs";
import { planSourceFor } from "./plan-source";
import { exclusive } from "../plan/service";
import { checkoutOf } from "../experiments/connections";

import type { Source } from "@chopin/experiment";
import type { BuildRequest, PlanSource } from "@chopin/protocol/implementation";
import type { HostedRepository } from "../agent/repository";
import type { AuthenticatedSession } from "../auth/session";
import type { Connection, Connections } from "../experiments/connections";
import type { Plan } from "../plan/service";
import type { ChannelRecord } from "../storage/model";
import type { ImplementationConnector } from "./connector";
import type { UnapprovedDecision } from "./open-decisions";

/**
 * The person's machine choice refuses the work: the machine they chose is offline or no longer
 * takes their work (409), or their choice cannot be read right now (503). The message says which.
 */
export class MachineRefused extends Error {
	constructor(readonly code: string, message: string, readonly status: number) {
		super(message);
	}
}

export type BuildPlanRefusalCode =
	| "child-document"
	| "document-archived"
	| "document-unavailable"
	| "repository-forbidden"
	| "implementation-active"
	| "revision-conflict"
	| "open-decisions"
	| "not-ready"
	| "graph-required"
	| "graph-stale"
	| "retry-required"
	| "already-built"
	| "nothing-to-build"
	| "agent-busy"
	| "no-workspace"
	| "machine-offline"
	| "machine-unavailable"
	| "machine-choice-unavailable"
	| "plan-source-unavailable"
	| "planner-not-attached"
	| "planner-unavailable";

export type StartPlanBuildInput = {
	channel: ChannelRecord;
	repository: HostedRepository;
	user: { id: string; login: string; avatarUrl?: string };
	session?: AuthenticatedSession;
	idempotencyKey?: string;
	planRevision?: number;
	requireSettledDecisions?: boolean;
	draftIfNeeded?: boolean;
	retry?: boolean;
	rebuild?: boolean;
};

export type StartPlanBuildResult =
	| { status: "started"; build: BuildRequest }
	| { status: "already-building"; build: BuildRequest }
	| { status: "rebuilding"; build: BuildRequest }
	| { status: "drafting"; planRevision: number }
	| {
		status: "refused";
		code: BuildPlanRefusalCode;
		message?: string;
		build?: BuildRequest;
		revision?: number;
		planRevision?: number;
		blockers?: string[];
		openDecisions?: UnapprovedDecision[];
	};

export type DraftBuildOutcome =
	| {
		kind: "drafting";
		planRevision: number;
		/** Resolves once the draft turn ends and has persisted any saved graph. */
		ended: Promise<void>;
		/** Releases any room hold once post-draft auto-queue completes. */
		release?: () => void;
	}
	| { kind: "planner-busy"; message?: string }
	| { kind: "planner-not-attached"; message?: string }
	| { kind: "planner-unavailable"; message?: string };

export type DraftBuildStarter = (input: {
	channel: ChannelRecord;
	repository: HostedRepository;
	user: { id: string; login: string; avatarUrl?: string };
	session?: AuthenticatedSession;
	planRevision: number;
}) => Promise<DraftBuildOutcome>;

export type BuildStarterDeps = {
	withPlan<T>(id: string, action: (plan: Plan) => Promise<T>): Promise<T>;
	connections: Connections;
	connector: Pick<ImplementationConnector, "busy" | "track">;
	busy?: (connectionId: string) => Promise<boolean>;
	liveBuild?: boolean;
	refuseOffline?: (owner: string, documentId: string) => Promise<never>;
	takers?: (owner: string, repositoryId: string, documentId: string) => Promise<Connection[]>;
	machineChoices?: () => Promise<void>;
	sourceFor?: (connection: Connection, documentId: string, plan?: PlanSource) => Promise<Source>;
	draftBuild?: DraftBuildStarter;
};

export type ExplicitBuildInput = {
	documentId: string;
	repositoryId: string;
	userId: string;
	planRevision: number;
	graphVersion: number;
	graphRevision: number;
	retryOf?: string;
	approvedBy?: string;
	operationKey?: string;
	requireBuildRequestedBy?: string;
};

export type ExplicitRebuildInput = {
	documentId: string;
	repositoryId: string;
	userId: string;
};

export type BuildStarter = {
	available(owner: string, repositoryId: string, id: string): Promise<Connection[]>;
	unavailable(owner: string, repositoryId: string, id: string): Promise<void>;
	queueExplicitBuild(
		input: ExplicitBuildInput,
	): Promise<
		| { ok: true; build: BuildRequest }
		| {
			ok: false;
			code: BuildPlanRefusalCode;
			message: string;
			httpStatus: number;
			machineRefused?: boolean;
		}
	>;
	queueExplicitRebuild(
		input: ExplicitRebuildInput,
	): Promise<
		| { ok: true; build: BuildRequest }
		| {
			ok: false;
			code: BuildPlanRefusalCode;
			message: string;
			httpStatus: number;
			blockers?: string[];
			machineRefused?: boolean;
		}
	>;
	startPlanBuild(input: StartPlanBuildInput): Promise<StartPlanBuildResult>;
};

export function createBuildStarter(deps: BuildStarterDeps): BuildStarter {
	let takers = deps.takers
		?? (async (owner: string, repositoryId: string, id: string) =>
			deps.connections.candidates(repositoryId, owner, id));

	/**
	 * The live connections that can take the caller's build for `id`: idle ones
	 * first, then those still running a prototype, then those building another document, which
	 * queue the build until theirs finishes. Within each, the one last used for this document
	 * first, then the most recently heard from. A build already waiting on this document does not
	 * make its connection busy, so a repeated request can return that build.
	 */
	async function available(owner: string, repositoryId: string, id: string): Promise<Connection[]> {
		if (!deps.liveBuild) {
			// Without LIVE_BUILD a busy connection is refused, never queued.
			let idle: Connection[] = [];
			for (let connection of await takers(owner, repositoryId, id)) {
				let here = deps.connections.assigned(connection.id) === id;
				if (await deps.busy?.(connection.id) || !here && await deps.connector.busy(connection)) {
					continue;
				}
				if (here) idle.unshift(connection);
				else idle.push(connection);
			}
			return idle;
		}
		let free: Connection[] = [];
		let prototyping: Connection[] = [];
		let building: Connection[] = [];
		for (let connection of await takers(owner, repositoryId, id)) {
			let here = deps.connections.assigned(connection.id) === id
				|| deps.connections.queued(connection.id).includes(id);
			let list = !here && await deps.connector.busy(connection)
				? building
				: await deps.busy?.(connection.id)
				? prototyping
				: free;
			if (here) list.unshift(connection);
			else list.push(connection);
		}
		return [...free, ...prototyping, ...building];
	}

	/**
	 * Refuse a Build that nothing can take: `machine-offline` naming the machine the person chose
	 * for the document, never silently another, `machine-unavailable` when it is a teammate's that
	 * no longer takes their work, `machine-choice-unavailable` while that choice cannot be read, or
	 * else `no-workspace`.
	 */
	async function unavailable(owner: string, repositoryId: string, id: string): Promise<void> {
		try {
			await deps.machineChoices?.();
			if ((await takers(owner, repositoryId, id)).length) return;
			await deps.refuseOffline?.(owner, id);
		} catch (error) {
			let code = (error as { code?: unknown } | undefined)?.code;
			if (
				code === "machine-offline" || code === "machine-unavailable"
				|| code === "machine-choice-unavailable"
			) {
				let message = (error as Error).message;
				throw new MachineRefused(code, message, code === "machine-choice-unavailable" ? 503 : 409);
			}
		}
		throw new MachineRefused("no-workspace", "no-workspace", 409);
	}

	async function checkUnavailable(owner: string, repositoryId: string, id: string) {
		try {
			await unavailable(owner, repositoryId, id);
			return undefined;
		} catch (error) {
			if (error instanceof MachineRefused) {
				let machineRefused = error.code === "machine-offline"
					|| error.code === "machine-unavailable"
					|| error.code === "machine-choice-unavailable";
				return {
					ok: false as const,
					code: error.code as BuildPlanRefusalCode,
					message: error.message,
					httpStatus: error.status,
					machineRefused,
				};
			}
			throw error;
		}
	}

	async function queueExplicitBuild(
		input: ExplicitBuildInput,
	): ReturnType<BuildStarter["queueExplicitBuild"]> {
		let { documentId: id, repositoryId, userId } = input;
		let refused = await checkUnavailable(userId, repositoryId, id);
		if (refused) return refused;
		let [connection] = await available(userId, repositoryId, id);
		if (!connection) {
			return {
				ok: false,
				code: deps.liveBuild ? "no-workspace" : "agent-busy",
				message: deps.liveBuild ? "no-workspace" : "workspace is offline or busy",
				httpStatus: 409,
			};
		}
		let planSource = await deps.withPlan(
			id,
			async plan => planSourceFor(plan.planSources, input.planRevision),
		);
		let source: Source | undefined;
		try {
			if (deps.sourceFor) source = await deps.sourceFor(connection, id, planSource);
			else {
				source = checkoutOf(connection, repositoryId);
				if (source && planSource) {
					source = { ...source, commit: planSource.commit, branch: planSource.branch };
				}
			}
		} catch (error) {
			let code = (error as { code?: unknown } | undefined)?.code;
			let name = typeof code === "string" ? code : "no-workspace";
			return {
				ok: false,
				code: (name === "plan-source-unavailable" ? name : "no-workspace") as BuildPlanRefusalCode,
				message: name,
				httpStatus: 409,
			};
		}
		if (!source) {
			return { ok: false, code: "no-workspace", message: "no-workspace", httpStatus: 409 };
		}
		let checkout = {
			repository: source.repository,
			commit: source.commit,
			...(source.branch ? { branch: source.branch } : {}),
		};
		deps.connector.track(id);
		return deps.connections.locked(connection.id, async () => {
			if (
				!deps.connections.get(connection.id)
				|| !deps.liveBuild
					&& !(await available(userId, repositoryId, id)).includes(connection)
			) {
				return {
					ok: false as const,
					code: (deps.liveBuild ? "no-workspace" : "agent-busy") as BuildPlanRefusalCode,
					message: deps.liveBuild ? "no-workspace" : "workspace is offline or busy",
					httpStatus: 409,
				};
			}
			return deps.withPlan(id, async plan => {
				try {
					let build = await queueBuild(plan, {
						...(input.retryOf ? { retryOf: input.retryOf } : {}),
						planRevision: input.planRevision,
						graphVersion: input.graphVersion,
						graphRevision: input.graphRevision,
						user: userId,
						...(connection.owner !== userId ? { machineOwner: connection.owner } : {}),
						connectionId: connection.id,
						machineId: connection.machineId,
						...(connection.about?.service ? { machineService: true as const } : {}),
						repositoryId,
						checkout,
						...(planSource ? { planSource } : {}),
						...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
						...(input.operationKey ? { operationKey: input.operationKey } : {}),
						...(input.requireBuildRequestedBy !== undefined
							? { requireBuildRequestedBy: input.requireBuildRequestedBy }
							: {}),
					});
					let holder = deps.connections.assigned(connection.id);
					// Another document's build holds the connection: this one starts after it.
					if (deps.liveBuild && holder && holder !== id) {
						deps.connections.enqueue(connection.id, id);
					} else deps.connections.assign(connection.id, id);
					deps.connections.use(id, connection.id);
					deps.connections.wake(repositoryId);
					return { ok: true as const, build };
				} catch (error) {
					let message = error instanceof Error ? error.message : "build refused";
					let code: BuildPlanRefusalCode = message === "implementation is already active"
						? "implementation-active"
						: message === "plan source has changed"
						? "plan-source-unavailable"
						: message === "reviewed graph has changed"
						? "revision-conflict"
						: "not-ready";
					return { ok: false as const, code, message, httpStatus: 409 };
				}
			});
		});
	}

	async function queueExplicitRebuild(
		input: ExplicitRebuildInput,
	): ReturnType<BuildStarter["queueExplicitRebuild"]> {
		let { documentId: id, repositoryId, userId } = input;
		let refused = await checkUnavailable(userId, repositoryId, id);
		if (refused) return refused;
		// Like Build: a connection running a prototype or another document's build is busy.
		let free: Connection[] = [];
		for (let connection of await takers(userId, repositoryId, id)) {
			let here = deps.connections.assigned(connection.id) === id;
			if (await deps.busy?.(connection.id) || !here && await deps.connector.busy(connection)) {
				continue;
			}
			free.push(connection);
		}
		if (!free.length) {
			return { ok: false, code: "agent-busy", message: "agent-busy", httpStatus: 409 };
		}
		let idle = new Set(free.map(connection => connection.id));
		deps.connector.track(id);
		let result = await deps.withPlan(
			id,
			plan =>
				queueRebuild(plan, {
					...deps.connections,
					get: connectionId =>
						idle.has(connectionId) ? deps.connections.get(connectionId) : undefined,
					list: (repoId, owner) =>
						[
							...owner ? deps.connections.favoriteShared(repoId, owner, id) : [],
							...deps.connections.list(repoId, owner),
							...owner ? deps.connections.chosenShared(repoId, owner, id) : [],
						].filter(item => idle.has(item.id)),
					assign: (connectionId, documentId) => deps.connections.assign(connectionId, documentId),
					assigned: connectionId => deps.connections.assigned(connectionId),
					allows: (documentId, connection, person) =>
						deps.connections.allows(documentId, connection, person),
					favoriteShared: (repoId, person, documentId) =>
						deps.connections.favoriteShared(repoId, person, documentId).filter(item =>
							idle.has(item.id)
						),
				}, { by: userId }),
		);
		if (result.kind === "busy") {
			return {
				ok: false,
				code: "implementation-active",
				message: "implementation is already active",
				httpStatus: 409,
			};
		}
		if (result.kind === "unchanged") {
			return {
				ok: false,
				code: "nothing-to-build",
				message: "nothing to build",
				httpStatus: 409,
			};
		}
		if (result.kind === "blocked") {
			return {
				ok: false,
				code: "not-ready",
				message: result.blockers.join(", "),
				blockers: result.blockers,
				httpStatus: 409,
			};
		}
		if (result.kind === "unavailable") {
			return { ok: false, code: "no-workspace", message: "no-workspace", httpStatus: 409 };
		}
		deps.connections.wake(repositoryId);
		return { ok: true, build: result.build };
	}

	async function clearBuildRequested(channelId: string, userId: string): Promise<void> {
		try {
			await deps.withPlan(channelId, plan =>
				exclusive(plan, async () => {
					if (plan.buildRequested?.by === userId) requestBuild(plan, undefined);
				}));
		} catch (error) {
			console.error("chopin: could not clear pending build request -", error);
		}
	}

	async function autoQueueAfterDraft(
		input: StartPlanBuildInput,
		expectedRevision: number,
	): Promise<void> {
		let { channel, user } = input;
		try {
			let candidate = await deps.withPlan(channel.id, plan =>
				exclusive(plan, async () => {
					let req = plan.buildRequested;
					if (!req || req.by !== user.id) return undefined;
					if (buildActive(plan)) {
						requestBuild(plan, undefined);
						return undefined;
					}
					if (req.revision !== plan.revision || plan.revision !== expectedRevision) {
						requestBuild(plan, undefined);
						return undefined;
					}
					let version = plan.graph?.versions.at(-1);
					if (!version || version.planRevision !== plan.revision) {
						requestBuild(plan, undefined);
						return undefined;
					}
					if (
						input.requireSettledDecisions
						&& unapprovedDecisions(plan.records.values()).length > 0
					) {
						requestBuild(plan, undefined);
						return undefined;
					}
					let ready = await planningReadiness(plan, plan.revision);
					if (!ready.ok) {
						requestBuild(plan, undefined);
						return undefined;
					}
					let eligibility = claimEligibility(plan.lifecycle, version, "probe");
					if (!eligibility.ok) {
						requestBuild(plan, undefined);
						return undefined;
					}
					let latestBuild = plan.builds.at(-1);
					let retryOf = latestBuild
							&& latestBuild.graphVersion === version.number
							&& latestBuild.graphRevision === version.revision
							&& latestBuild.planRevision === plan.revision
							&& (latestBuild.state === "failed" || latestBuild.state === "stopped")
						? latestBuild.id
						: undefined;
					return {
						planRevision: plan.revision,
						graphVersion: version.number,
						graphRevision: version.revision,
						...(retryOf ? { retryOf } : {}),
					};
				}));
			if (!candidate) return;
			let queued = await queueExplicitBuild({
				documentId: channel.id,
				repositoryId: channel.repositoryId,
				userId: user.id,
				planRevision: candidate.planRevision,
				graphVersion: candidate.graphVersion,
				graphRevision: candidate.graphRevision,
				...(candidate.retryOf ? { retryOf: candidate.retryOf } : {}),
				approvedBy: user.login,
				...(input.idempotencyKey ? { operationKey: input.idempotencyKey } : {}),
				requireBuildRequestedBy: user.id,
			});
			if (!queued.ok) await clearBuildRequested(channel.id, user.id);
		} catch (error) {
			console.error("chopin: could not auto-queue build after draft -", error);
			await clearBuildRequested(channel.id, user.id);
		}
	}

	async function startPlanBuild(input: StartPlanBuildInput): Promise<StartPlanBuildResult> {
		let { channel, user } = input;
		if (channel.parentChannelId) {
			return {
				status: "refused",
				code: "child-document",
				message: "Child documents cannot be built.",
			};
		}
		if (channel.archivedAt) {
			return { status: "refused", code: "document-archived" };
		}

		let draftIfNeeded = input.draftIfNeeded !== false;
		let requireSettledDecisions = input.requireSettledDecisions === true;

		type Inspection =
			| { kind: "immediate"; result: StartPlanBuildResult }
			| { kind: "rebuild" }
			| { kind: "draft"; planRevision: number; missingGraph: boolean }
			| {
				kind: "queue";
				planRevision: number;
				graphVersion: number;
				graphRevision: number;
				retryOf?: string;
			};

		let inspection = await deps.withPlan(
			channel.id,
			plan =>
				exclusive(plan, async (): Promise<Inspection> => {
					// 1. Active build check FIRST: idempotent match or mutual exclusion.
					let active = plan.builds.findLast(build =>
						["queued", "starting", "running"].includes(build.state)
					);
					if (active) {
						let matchesCaller = active.user === user.id
							&& (input.planRevision === undefined || active.planRevision === input.planRevision);
						if (matchesCaller) {
							return {
								kind: "immediate",
								result: { status: "already-building", build: structuredClone(active) },
							};
						}
						return {
							kind: "immediate",
							result: {
								status: "refused",
								code: "implementation-active",
								build: structuredClone(active),
							},
						};
					}
					if (plan.execution || plan.claiming) {
						return {
							kind: "immediate",
							result: { status: "refused", code: "implementation-active" },
						};
					}

					// 2. Plan revision fence.
					if (input.planRevision !== undefined && input.planRevision !== plan.revision) {
						return {
							kind: "immediate",
							result: {
								status: "refused",
								code: "revision-conflict",
								revision: plan.revision,
							},
						};
					}

					// 3. Optional open-decisions gate (default false for browser Build parity).
					if (requireSettledDecisions) {
						let openDecisions = unapprovedDecisions(plan.records.values());
						if (openDecisions.length > 0) {
							return {
								kind: "immediate",
								result: {
									status: "refused",
									code: "open-decisions",
									openDecisions,
								},
							};
						}
					}

					// 4. Plan readiness blockers.
					let ready = await planningReadiness(plan, plan.revision);
					if (!ready.ok) {
						return {
							kind: "immediate",
							result: {
								status: "refused",
								code: "not-ready",
								blockers: ready.blockers,
							},
						};
					}

					// 5. Living-document rebuild path.
					if (input.rebuild && plan.live) return { kind: "rebuild" };

					// 6. Graph currency check.
					let version = plan.graph?.versions.at(-1);
					if (!version || version.planRevision !== plan.revision) {
						let missingGraph = !version;
						if (!draftIfNeeded) {
							return {
								kind: "immediate",
								result: {
									status: "refused",
									code: missingGraph ? "graph-required" : "graph-stale",
									planRevision: plan.revision,
								},
							};
						}
						return { kind: "draft", planRevision: plan.revision, missingGraph };
					}

					// Check if this exact graph version already completed or ended.
					let eligibility = claimEligibility(plan.lifecycle, version, "probe");
					let latestBuild = plan.builds.at(-1);
					let sameGraphBuild = latestBuild
							&& latestBuild.graphVersion === version.number
							&& latestBuild.graphRevision === version.revision
							&& latestBuild.planRevision === plan.revision
						? latestBuild
						: undefined;
					if (!eligibility.ok) {
						return {
							kind: "immediate",
							result: {
								status: "refused",
								code: "already-built",
								...(sameGraphBuild ? { build: structuredClone(sameGraphBuild) } : {}),
								message: plan.live
									? "This revision is already built. Edit the document and pass rebuild: true to build changes."
									: "This graph version has already been built.",
							},
						};
					}
					if (
						sameGraphBuild
						&& (sameGraphBuild.state === "failed" || sameGraphBuild.state === "stopped")
					) {
						if (!input.retry) {
							return {
								kind: "immediate",
								result: {
									status: "refused",
									code: "retry-required",
									build: structuredClone(sameGraphBuild),
									message:
										"The previous build for this revision ended. Pass retry: true to retry it.",
								},
							};
						}
						return {
							kind: "queue",
							planRevision: plan.revision,
							graphVersion: version.number,
							graphRevision: version.revision,
							retryOf: sameGraphBuild.id,
						};
					}

					return {
						kind: "queue",
						planRevision: plan.revision,
						graphVersion: version.number,
						graphRevision: version.revision,
					};
				}),
		);

		if (inspection.kind === "immediate") return inspection.result;

		if (inspection.kind === "rebuild") {
			let rebuilt = await queueExplicitRebuild({
				documentId: channel.id,
				repositoryId: channel.repositoryId,
				userId: user.id,
			});
			if (rebuilt.ok) return { status: "rebuilding", build: rebuilt.build };
			return {
				status: "refused",
				code: rebuilt.code,
				...(rebuilt.message ? { message: rebuilt.message } : {}),
				...(rebuilt.blockers ? { blockers: rebuilt.blockers } : {}),
			};
		}

		if (inspection.kind === "draft") {
			if (!deps.draftBuild) {
				return {
					status: "refused",
					code: inspection.missingGraph ? "graph-required" : "graph-stale",
					planRevision: inspection.planRevision,
					message:
						`No current implementation graph exists for revision ${inspection.planRevision}. `
						+ "Call edit_implementation_graph first, then call build_plan.",
				};
			}
			let drafted = await deps.draftBuild({
				channel,
				repository: input.repository,
				user,
				...(input.session ? { session: input.session } : {}),
				planRevision: inspection.planRevision,
			});
			if (drafted.kind === "planner-busy") {
				return {
					status: "refused",
					code: inspection.missingGraph ? "graph-required" : "graph-stale",
					planRevision: inspection.planRevision,
					message:
						`No current implementation graph exists for revision ${inspection.planRevision}. `
						+ "Call edit_implementation_graph first, then call build_plan.",
				};
			}
			if (drafted.kind === "planner-not-attached" || drafted.kind === "planner-unavailable") {
				return {
					status: "refused",
					code: drafted.kind,
					...(drafted.message ? { message: drafted.message } : {}),
				};
			}
			// Ensure buildRequested is recorded before hooking auto-queue completion.
			await deps.withPlan(channel.id, plan =>
				exclusive(plan, async () => {
					if (!plan.buildRequested) requestBuild(plan, user.id);
				}));
			void drafted.ended
				.then(
					() => autoQueueAfterDraft(input, drafted.planRevision),
					() => clearBuildRequested(channel.id, user.id),
				)
				.finally(() => drafted.release?.());
			return { status: "drafting", planRevision: drafted.planRevision };
		}

		let queued = await queueExplicitBuild({
			documentId: channel.id,
			repositoryId: channel.repositoryId,
			userId: user.id,
			planRevision: inspection.planRevision,
			graphVersion: inspection.graphVersion,
			graphRevision: inspection.graphRevision,
			...(inspection.retryOf ? { retryOf: inspection.retryOf } : {}),
			approvedBy: user.login,
			...(input.idempotencyKey ? { operationKey: input.idempotencyKey } : {}),
		});
		if (queued.ok) return { status: "started", build: queued.build };
		return {
			status: "refused",
			code: queued.code,
			...(queued.message ? { message: queued.message } : {}),
		};
	}

	return {
		available,
		unavailable,
		queueExplicitBuild,
		queueExplicitRebuild,
		startPlanBuild,
	};
}
