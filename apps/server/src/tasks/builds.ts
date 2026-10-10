import { z } from "zod";
import { approveGraph, validate } from "./graphs";
import { implementationReadiness } from "./plan-graphs";
import {
	claimEligibility,
	historyFor,
	implementationLifecycle,
	progressFor,
	resumeLiveRun,
	transition,
} from "./lifecycle";
import { announceImplementation } from "./notifications";
import { drain, exclusive, persistExclusive, source } from "../plan/service";
import { broadcast } from "../wire";
import type { Plan } from "../plan/service";
import type { Connection } from "../experiments/connections";
import type { Lifecycle, ProgressEvent } from "./lifecycle";
import type { Graph, Run } from "./graphs";
import type { BuildRequest, CheckoutContext, LiveSnapshot } from "@chopin/protocol/implementation";

export let checkoutSchema = z.object({
	repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	branch: z.string().min(1).max(255).optional(),
	commit: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
let buildSchema = z.object({
	id: z.string().uuid(),
	retryOf: z.string().uuid().optional(),
	user: z.string().min(1).max(128),
	connectionId: z.string().min(1).max(128),
	repositoryId: z.string().min(1).max(128),
	checkout: checkoutSchema,
	planRevision: z.number().int().nonnegative(),
	graphVersion: z.number().int().positive(),
	graphRevision: z.number().int().positive(),
	createdAt: z.string().datetime(),
	expiresAt: z.number().int().nonnegative(),
	state: z.enum(["queued", "starting", "running", "stopped", "failed"]),
	session: z.string().min(1).max(128).optional(),
	error: z.string().max(2000).optional(),
	kind: z.literal("rebuild").optional(),
	baseRevision: z.number().int().nonnegative().optional(),
	targetRevision: z.number().int().nonnegative().optional(),
}).strict().refine(
	build =>
		build.kind === "rebuild"
			? build.baseRevision !== undefined && build.targetRevision !== undefined
				&& build.baseRevision <= build.targetRevision
			: build.baseRevision === undefined && build.targetRevision === undefined,
	"invalid rebuild revisions",
);

/** Whether a build closes document editing. A rebuild works from a sealed delta instead. */
export function locksEditing(build: { state: string; kind?: string }): boolean {
	return build.kind !== "rebuild" && ["queued", "starting", "running"].includes(build.state);
}

export function restoreBuilds(value: unknown, repositoryId?: string): BuildRequest[] {
	if (value === undefined) return [];
	let builds = z.array(buildSchema).max(100).parse(value);
	if (
		new Set(builds.map(build => build.id)).size !== builds.length
		|| repositoryId && builds.some(build => build.repositoryId !== repositoryId)
	) {
		throw new Error("invalid implementation builds");
	}
	return builds;
}

let liveSchema = z.object({
	buildId: z.string().uuid(),
	user: z.string().min(1).max(128),
	repositoryId: z.string().min(1).max(128),
	checkout: checkoutSchema,
	baseRevision: z.number().int().nonnegative(),
	baseSource: z.string(),
	/** Empty only when a first build stopped on a blocker before opening any pull request. */
	pullRequests: z.array(z.string().url()).max(100),
	/** Commits rebuilds landed on the live pull requests, newest last. */
	commits: z.array(
		z.object({
			pullRequest: z.string().url(),
			sha: z.string().regex(/^[a-f0-9]{7,40}$/),
			message: z.string().min(1).max(500),
			revision: z.number().int().nonnegative(),
			at: z.string().datetime(),
		}).strict(),
	).max(200).optional(),
	/** Tasks a first build stopped short of; the next rebuild finishes them. */
	outstanding: z.array(z.string().min(1).max(128)).min(1).max(100).optional(),
	/**
	 * Syncs that needed no code, newest last, so they still leave a trace: a rebuild that landed
	 * without a commit or task, or a declined gate check under a fresh id.
	 */
	noChange: z.array(
		z.object({
			buildId: z.string().uuid(),
			revision: z.number().int().nonnegative(),
			summary: z.string().min(1).max(2000),
			at: z.string().datetime(),
		}).strict(),
	).max(50).optional(),
	/** The source a queued rebuild targets, sealed so later edits join the next delta. */
	target: z.object({
		buildId: z.string().uuid(),
		revision: z.number().int().nonnegative(),
		source: z.string(),
	}).strict().optional(),
}).strict();

/** The built source a living document compares later edits against. */
export type LiveBuild = z.infer<typeof liveSchema>;

/** Restore a live record only when it names a finished build of this document. */
export function restoreLive(
	value: unknown,
	builds: BuildRequest[],
	history: Array<{ run: { id: string }; live?: true }>,
	revision: number,
): LiveBuild {
	let live = liveSchema.parse(value);
	let build = builds.find(item => item.id === live.buildId);
	if (
		!build || build.user !== live.user || build.repositoryId !== live.repositoryId
		|| build.checkout.repository !== live.checkout.repository
		|| build.checkout.branch !== live.checkout.branch
		|| build.checkout.commit !== live.checkout.commit
		|| !history.some(item => item.run.id === live.buildId && item.live)
		|| live.baseRevision > revision
		|| new Set(live.pullRequests).size !== live.pullRequests.length
		|| live.commits?.some(commit => !live.pullRequests.includes(commit.pullRequest))
		|| live.target && (
				live.target.revision > revision || live.target.revision < live.baseRevision
				|| !builds.some(item => item.id === live.target!.buildId && item.kind === "rebuild")
			)
	) {
		throw new Error("invalid live build");
	}
	return live;
}

type BuildInput = {
	retryOf?: string;
	planRevision: number;
	graphVersion: number;
	graphRevision: number;
	user: string;
	connectionId: string;
	repositoryId: string;
	checkout: CheckoutContext;
};

export async function queueBuild(plan: Plan, input: BuildInput): Promise<BuildRequest> {
	let claiming = plan.claiming;
	plan.claiming = true;
	try {
		await drain(plan);
		return await exclusive(plan, async () => {
			let version = plan.graph?.versions.at(-1);
			if (
				!version || input.planRevision !== plan.revision
				|| version.planRevision !== input.planRevision || version.number !== input.graphVersion
				|| version.revision !== input.graphRevision
			) throw new Error("reviewed graph has changed");
			let existing = plan.builds.at(-1);
			if (
				existing && existing.graphVersion === input.graphVersion
				&& existing.graphRevision === input.graphRevision
				&& existing.planRevision === input.planRevision
			) {
				let sameOwnerAndCheckout = existing.user === input.user
					&& existing.connectionId === input.connectionId
					&& existing.repositoryId === input.repositoryId
					&& existing.checkout.repository === input.checkout.repository
					&& existing.checkout.commit === input.checkout.commit
					&& existing.checkout.branch === input.checkout.branch;
				if (sameOwnerAndCheckout && existing.retryOf === input.retryOf) {
					return structuredClone(existing);
				}
				if (input.retryOf !== existing.id || !["failed", "stopped"].includes(existing.state)) {
					throw new Error("review the existing build before retrying");
				}
			} else if (input.retryOf) {
				throw new Error("reviewed build has changed");
			}
			if (
				plan.execution
				|| plan.builds.some(build => ["queued", "starting", "running"].includes(build.state))
			) throw new Error("implementation is already active");
			let ready = implementationReadiness(plan, input.planRevision);
			if (!ready.ok) throw new Error(ready.blockers.join(", "));
			let id = crypto.randomUUID();
			let eligibility = claimEligibility(plan.lifecycle, version, id);
			if (!eligibility.ok) throw new Error(eligibility.reason);
			let result = version.state === "approved"
				? { ok: true as const, value: structuredClone(plan.graph!) }
				: approveGraph({ graph: plan.graph, revision: plan.revision });
			if (!result.ok) throw new Error(result.reason);
			let build: BuildRequest = buildSchema.parse({
				...input,
				id,
				createdAt: new Date().toISOString(),
				expiresAt: Date.now() + 90_000,
				state: "queued",
			});
			if (plan.builds.length >= 100) throw new Error("build history is full");
			let previous = { graph: plan.graph, builds: plan.builds };
			plan.graph = result.value;
			plan.builds = [...plan.builds, build];
			try {
				await persistExclusive(plan, true);
			} catch (error) {
				Object.assign(plan, previous);
				throw error;
			}
			announceImplementation(plan);
			return structuredClone(build);
		});
	} finally {
		plan.claiming = claiming;
	}
}

export type RebuildConnections = {
	get: (id: string) => Connection | undefined;
	list: (repositoryId: string, owner?: string) => Connection[];
	assign: (connectionId: string, documentId: string) => void;
	assigned: (connectionId: string) => string | undefined;
};

export type RebuildResult =
	| { kind: "queued"; build: BuildRequest }
	| { kind: "busy" }
	| { kind: "unchanged" }
	| { kind: "unavailable" };

/** Whether any build or claim is in flight, including rebuilds that leave editing open. */
export function buildActive(plan: Plan): boolean {
	return plan.claiming || !!plan.execution
		|| plan.builds.some(build => ["queued", "starting", "running"].includes(build.state));
}

/**
 * Queue a rebuild of a live document's edits onto its pull requests.
 *
 * The live build's user keeps ownership; its original connection is preferred, and another of the
 * same user's connections for this repository stands in once that one has gone. A connection
 * already holding another document's build is skipped so the rebuild cannot strand that build.
 */
export async function queueRebuild(
	plan: Plan,
	connections: RebuildConnections,
): Promise<RebuildResult> {
	await drain(plan);
	return exclusive(plan, async () => {
		let live = plan.live;
		if (!plan.persistence.liveBuild || !live) return { kind: "unavailable" };
		if (buildActive(plan)) return { kind: "busy" };
		if (source(plan) === live.baseSource) return { kind: "unchanged" };
		let original = plan.builds.find(build => build.id === live.buildId);
		let usable = (connection: Connection | undefined) => {
			let assigned = connection && connections.assigned(connection.id);
			return !!connection && connection.owner === live.user
				&& connection.source.repositoryId === live.repositoryId
				&& (assigned === undefined || assigned === plan.id);
		};
		let connection = original && connections.get(original.connectionId);
		if (!usable(connection)) {
			connection = connections.list(live.repositoryId, live.user).find(usable);
		}
		if (!original || !connection) return { kind: "unavailable" };
		if (plan.builds.length >= 100) {
			console.warn(`chopin: living document ${plan.id} cannot rebuild - build history is full`);
			return { kind: "unavailable" };
		}
		let build: BuildRequest = buildSchema.parse({
			id: crypto.randomUUID(),
			kind: "rebuild",
			user: live.user,
			connectionId: connection.id,
			repositoryId: live.repositoryId,
			checkout: {
				repository: connection.source.repository,
				commit: connection.source.commit,
				...(connection.source.branch ? { branch: connection.source.branch } : {}),
			},
			planRevision: plan.revision,
			baseRevision: live.baseRevision,
			targetRevision: plan.revision,
			graphVersion: original.graphVersion,
			graphRevision: original.graphRevision,
			createdAt: new Date().toISOString(),
			expiresAt: Date.now() + 90_000,
			state: "queued",
		});
		let previous = { builds: plan.builds, live };
		plan.builds = [...previous.builds, build];
		plan.live = {
			...live,
			target: { buildId: build.id, revision: plan.revision, source: source(plan) },
		};
		try {
			await persistExclusive(plan, true);
		} catch (error) {
			Object.assign(plan, previous);
			throw error;
		}
		connections.assign(connection.id, plan.id);
		announceImplementation(plan);
		return { kind: "queued", build: structuredClone(build) };
	});
}

/**
 * Record that an edit needed no code: the live base advances to the checked source with a
 * no-change entry, so the document reads as in sync without a rebuild.
 */
export async function settleLive(
	plan: Plan,
	checked: { baseSource: string; revision: number; source: string; summary: string },
): Promise<boolean> {
	await drain(plan);
	return exclusive(plan, async () => {
		let live = plan.live;
		if (
			!live || live.baseSource !== checked.baseSource || live.outstanding?.length
			|| buildActive(plan) || checked.revision > plan.revision
		) return false;
		let previous = live;
		plan.live = {
			...live,
			baseRevision: checked.revision,
			baseSource: checked.source,
			noChange: [
				...(live.noChange ?? []),
				{
					buildId: crypto.randomUUID(),
					revision: checked.revision,
					summary: checked.summary,
					at: new Date().toISOString(),
				},
			].slice(-50),
		};
		try {
			await persistExclusive(plan, true);
		} catch (error) {
			plan.live = previous;
			throw error;
		}
		announceImplementation(plan);
		return true;
	});
}

/** Persist pickup before the companion receives permission to spawn a process. */
export function pickBuild(
	plan: Plan,
	user: string,
	connectionId: string,
): Promise<BuildRequest | undefined> {
	return exclusive(plan, async () => {
		let build = plan.builds.at(-1);
		if (
			!build || build.user !== user || build.connectionId !== connectionId
			|| build.state !== "queued"
		) {
			return;
		}
		let previous = plan.builds;
		let next: BuildRequest = { ...build, state: "starting", expiresAt: Date.now() + 60_000 };
		plan.builds = [...previous.slice(0, -1), next];
		try {
			await persistExclusive(plan, true);
		} catch (error) {
			plan.builds = previous;
			throw error;
		}
		announceImplementation(plan);
		return structuredClone(next);
	});
}

export function reportBuild(
	plan: Plan,
	user: string,
	connectionId: string,
	id: string,
	report: {
		state: "starting" | "running" | "stopped" | "failed";
		session?: string;
		error?: string;
		expiresAt?: number;
	},
): Promise<void> {
	return exclusive(plan, async () => {
		let current = plan.builds.at(-1);
		if (
			!current || current.id !== id || current.user !== user
			|| current.connectionId !== connectionId
		) {
			throw new Error("build is unavailable");
		}
		if (
			current.state === "queued" && report.state !== "failed"
			|| (current.state === "failed" || current.state === "stopped")
				&& JSON.stringify({ ...current, ...report }) !== JSON.stringify(current)
		) {
			throw new Error("build report is out of order");
		}
		let next = buildSchema.parse({ ...current, ...report });
		let previous = {
			builds: plan.builds,
			graph: plan.graph,
			execution: plan.execution,
			lifecycle: plan.lifecycle,
			live: plan.live,
		};
		plan.builds = [...previous.builds.slice(0, -1), next];
		if (current.state !== next.state && (next.state === "stopped" || next.state === "failed")) {
			liveFromStopped(plan, next);
		}
		try {
			await persistExclusive(plan, true);
		} catch (error) {
			Object.assign(plan, previous);
			throw error;
		}
		if (
			current.state !== next.state || current.session !== next.session
			|| current.error !== next.error
		) announceImplementation(plan);
		if (current.state !== next.state && (next.state === "stopped" || next.state === "failed")) {
			plan.persistence.onBuildStopped?.(plan.id);
		}
	});
}

/**
 * A first live build that stops short of its last task still goes live from what it delivered, so
 * later edits resume its outstanding tasks through a rebuild. It needs at least one pull request.
 */
function liveFromStopped(plan: Plan, build: BuildRequest): void {
	let run = plan.execution;
	if (
		!plan.persistence.liveBuild || plan.live || build.kind === "rebuild" || !plan.graph
		|| run?.id !== build.id
	) return;
	let progress = progressFor(plan.graph, plan.lifecycle, run);
	if (!progress) return;
	let pullRequests = [
		...new Set(
			progress.tasks.flatMap(task =>
				task.state !== "queued" && task.pullRequest ? [task.pullRequest.url] : []
			),
		),
	];
	let outstanding = progress.tasks.flatMap(task => task.state === "completed" ? [] : [task.id]);
	// With no pull request yet, only a blocker makes it live, so an edit that answers it retries.
	if (
		outstanding.length === 0
		|| pullRequests.length === 0 && !progress.tasks.some(task => task.state === "blocked")
	) return;
	let result = transition({
		graph: plan.graph,
		execution: run,
		lifecycle: plan.lifecycle,
	}, {
		kind: "request_revision",
		runId: run.id,
		reason: "The build stopped with outstanding tasks. Later edits resume them.",
		idempotencyKey: `${run.id}:live-stop`,
	});
	if (result.kind !== "accepted") return;
	let archived = result.state.lifecycle.history.at(-1);
	if (archived?.run.id !== run.id) return;
	archived.live = true;
	plan.graph = result.state.graph;
	plan.execution = result.state.execution;
	plan.lifecycle = result.state.lifecycle;
	plan.live = {
		buildId: build.id,
		user: build.user,
		repositoryId: build.repositoryId,
		checkout: structuredClone(build.checkout),
		baseRevision: plan.revision,
		baseSource: source(plan),
		pullRequests,
		outstanding,
	};
}

/**
 * Apply a rebuild's outcomes for the first build's outstanding tasks to that archived run, in graph
 * order. A done task is started, given its pull request and completed; a blocked one records its
 * blocker. Done and dropped tasks leave the outstanding list; an outcome the lifecycle refuses, such
 * as a done task whose dependency is still unfinished, leaves its task outstanding.
 */
function resumeOutstanding(
	graph: Graph,
	start: Lifecycle,
	live: LiveBuild,
	buildId: string,
	report: RebuildReport,
): { lifecycle: Lifecycle; outstanding: string[] } | undefined {
	let outcomes = report.outstanding ?? [];
	let index = start.history.findIndex(item => item.run.id === live.buildId);
	let archived = start.history[index];
	let version = archived && graph.versions.find(item => item.number === archived.run.graphVersion);
	if (!live.outstanding || !outcomes.length || !version) return;
	let lifecycle = start;
	let remaining = new Set(live.outstanding);
	for (let task of version.definition.tasks) {
		let outcome = outcomes.find(item => item.taskId === task.id);
		if (!outcome || !remaining.has(task.id)) continue;
		if (outcome.outcome === "dropped") {
			remaining.delete(task.id);
			continue;
		}
		let item = historyFor(graph, lifecycle)[index]?.progress.tasks.find(item =>
			item.id === task.id
		);
		if (!item || item.state === "completed") continue;
		let key = `${buildId}:${task.id}`;
		let events: ProgressEvent[] = [];
		if (outcome.outcome === "blocked") {
			// A live run replaces a blocker directly, so an unfinished dependency cannot refuse it.
			events.push({
				kind: "block",
				taskId: task.id,
				reason: outcome.blocker,
				idempotencyKey: `${key}:block`,
			});
		} else {
			let existing = item.state !== "queued" ? item.pullRequest?.url : undefined;
			let url = outcome.pullRequest ?? existing;
			if (!url) continue;
			if (item.state !== "in_progress") {
				events.push({ kind: "start", taskId: task.id, idempotencyKey: `${key}:start` });
			}
			// Reporting the task's own pull request again as open would be refused once it merged.
			if (url !== existing) {
				events.push({
					kind: "report_pr",
					taskId: task.id,
					url,
					state: "open",
					idempotencyKey: `${key}:pr`,
				});
			}
			events.push({
				kind: "complete",
				taskId: task.id,
				summary: report.summary,
				idempotencyKey: `${key}:done`,
			});
		}
		let next = resumeLiveRun(graph, lifecycle, live.buildId, events);
		if (!next) continue;
		lifecycle = next;
		if (outcome.outcome === "done") remaining.delete(task.id);
	}
	return { lifecycle, outstanding: [...remaining] };
}

/** The tasks a first build left unfinished, with their blockers and any pull request. */
function outstandingTasks(plan: Plan) {
	let live = plan.live;
	if (!live?.outstanding || !plan.graph) return [];
	let index = plan.lifecycle.history.findIndex(item => item.run.id === live.buildId);
	let archived = plan.lifecycle.history[index];
	let version = archived
		&& plan.graph.versions.find(item => item.number === archived.run.graphVersion);
	let progress = historyFor(plan.graph, plan.lifecycle)[index]?.progress.tasks ?? [];
	return live.outstanding.flatMap(id => {
		let task = version?.definition.tasks.find(item => item.id === id);
		let item = progress.find(item => item.id === id);
		if (!task || !item || item.state === "completed") return [];
		return [{
			id,
			title: task.title,
			goal: task.goal,
			acceptance: task.acceptance,
			state: item.state,
			...(item.state === "blocked" ? { blocker: item.blocker } : {}),
			...(item.state !== "queued" && item.pullRequest
				? { pullRequest: item.pullRequest.url }
				: {}),
		}];
	});
}

export let rebuildReportSchema = z.object({
	summary: z.string().trim().min(1).max(2000),
	commits: z.array(
		z.object({
			pullRequest: z.string().url(),
			sha: z.string().regex(/^[a-f0-9]{7,40}$/),
			message: z.string().trim().min(1).max(500),
		}).strict(),
	).max(50),
	tasks: z.array(
		z.object({
			title: z.string().trim().min(1).max(200),
			goal: z.string().trim().min(1).max(2000),
			pullRequest: z.string().url(),
		}).strict(),
	).max(20),
	/** What became of each outstanding task; a task left out stays outstanding. */
	outstanding: z.array(
		z.discriminatedUnion("outcome", [
			z.object({
				taskId: z.string().min(1).max(128),
				outcome: z.literal("done"),
				/** Required when the task had no pull request. */
				pullRequest: z.string().url().optional(),
			}).strict(),
			z.object({
				taskId: z.string().min(1).max(128),
				outcome: z.literal("blocked"),
				blocker: z.string().trim().min(1).max(2000),
			}).strict(),
			z.object({ taskId: z.string().min(1).max(128), outcome: z.literal("dropped") }).strict(),
		]),
	).max(100).optional(),
}).strict();
export type RebuildReport = z.infer<typeof rebuildReportSchema>;

/** Completed tasks of every live run, in delivery order. */
function liveTasks(plan: Plan) {
	if (!plan.graph) return [];
	let graph = plan.graph;
	let projected = historyFor(graph, plan.lifecycle);
	return plan.lifecycle.history.flatMap((archived, index) => {
		let version = graph.versions.find(item => item.number === archived.run.graphVersion);
		let progress = projected[index]?.progress.tasks ?? [];
		if (!archived.live || !version) return [];
		return progress.flatMap(item => {
			let task = version.definition.tasks.find(task => task.id === item.id);
			return item.state === "completed" && task
				? [{
					title: task.title,
					goal: task.goal,
					pullRequest: item.pullRequest.url,
					summary: item.summary,
				}]
				: [];
		});
	});
}

/** The sealed delta a running rebuild implements. */
export function readRebuild(plan: Plan, buildId: string) {
	return exclusive(plan, async () => {
		let live = plan.live;
		let build = plan.builds.at(-1);
		if (!live?.target || live.target.buildId !== buildId || build?.id !== buildId) return;
		let tasks = liveTasks(plan);
		let outstanding = outstandingTasks(plan);
		return {
			before: live.baseSource,
			after: live.target.source,
			baseRevision: live.baseRevision,
			targetRevision: live.target.revision,
			pullRequests: live.pullRequests.map(url => ({
				url,
				title: tasks.find(task => task.pullRequest === url)?.title ?? "",
			})),
			tasks,
			...(outstanding.length ? { outstanding } : {}),
		};
	});
}

/**
 * Land a rebuild: record its commits, append its tasks as a completed graph version, advance the
 * live base to the sealed target, and stop the build so a deferred live check can run.
 */
export function reportRebuild(
	plan: Plan,
	buildId: string,
	report: RebuildReport,
): Promise<{ kind: "accepted" } | { kind: "refused"; reason: string }> {
	return exclusive(plan, async () => {
		let live = plan.live;
		let build = plan.builds.at(-1);
		let target = live?.target;
		if (
			!live || !target || !build || build.id !== buildId
			|| build.kind !== "rebuild" || build.state !== "running" || target.buildId !== buildId
		) return { kind: "refused", reason: "build-inactive" };
		// Only an outstanding task that had no pull request may bring a new one, in the same repository.
		let openings = outstandingTasks(plan).filter(task => !task.pullRequest).length;
		let opened = [
			...new Set(
				[...report.commits, ...report.tasks, ...report.outstanding ?? []].flatMap(item =>
					"pullRequest" in item && item.pullRequest && !live.pullRequests.includes(item.pullRequest)
						? [item.pullRequest]
						: []
				),
			),
		];
		let prefix = `https://github.com/${live.checkout.repository}/pull/`;
		if (
			opened.length > openings
			|| opened.some(url => !url.startsWith(prefix) || !/^\d+$/.test(url.slice(prefix.length)))
		) return { kind: "refused", reason: "pull-request" };
		let at = new Date().toISOString();
		let graph = plan.graph && structuredClone(plan.graph);
		let resumed = graph && resumeOutstanding(graph, plan.lifecycle, live, build.id, report);
		let lifecycle = resumed?.lifecycle ?? structuredClone(plan.lifecycle);
		let latest = graph?.versions.at(-1);
		// A draft the Planner started since the build keeps its place; only the commits are recorded.
		if (graph && latest && report.tasks.length > 0 && latest.state === "approved") {
			let number = latest.number + 1;
			let checked = validate({
				tasks: report.tasks.map((task, index) => ({
					id: `rebuild-${number}-${index + 1}`,
					title: task.title,
					context:
						`Living-document rebuild of revisions ${live.baseRevision} to ${target.revision}.`,
					goal: task.goal,
					acceptance: [
						`Committed on ${task.pullRequest}.`,
						`Reflects the document change since revision ${live.baseRevision}.`,
					],
					dependsOn: [],
				})),
			});
			if (!checked.ok) return { kind: "refused", reason: checked.reason };
			latest.state = "superseded";
			// LIVE_BUILD prototype: a rebuild's tasks are approved and completed by the coding agent's
			// report alone. This deliberately bypasses the human-only graph approval.
			graph.versions.push({
				number,
				revision: 1,
				planRevision: plan.revision,
				state: "approved",
				definition: checked.value,
			});
			let run: Run = {
				id: build.id,
				user: build.user,
				client: { name: "chopin-acp", version: "0.1.0" },
				session: build.session ?? build.id,
				planRevision: plan.revision,
				graphVersion: number,
				graphRevision: 1,
				repository: live.checkout.repository,
				branch: `chopin/rebuild-${build.id.slice(0, 8)}`,
				commit: build.checkout.commit,
				startedAt: build.createdAt,
			};
			let events: ProgressEvent[] = checked.value.tasks.flatMap((task, index) => {
				let key = `${build.id}:${task.id}`;
				return [
					{ kind: "start" as const, taskId: task.id, idempotencyKey: `${key}:start` },
					{
						kind: "report_pr" as const,
						taskId: task.id,
						url: report.tasks[index]!.pullRequest,
						state: "open" as const,
						idempotencyKey: `${key}:pr`,
					},
					{
						kind: "complete" as const,
						taskId: task.id,
						summary: report.summary,
						idempotencyKey: `${key}:complete`,
					},
				];
			});
			lifecycle.history.push({ run, events, live: true });
		}
		let { target: _target, outstanding: _outstanding, ...base } = live;
		let outstanding = resumed?.outstanding ?? live.outstanding ?? [];
		let previous = {
			graph: plan.graph,
			lifecycle: plan.lifecycle,
			live: plan.live,
			builds: plan.builds,
		};
		plan.graph = graph;
		plan.lifecycle = lifecycle;
		plan.live = {
			...base,
			baseRevision: target.revision,
			baseSource: target.source,
			pullRequests: [...live.pullRequests, ...opened],
			...(outstanding.length ? { outstanding } : {}),
			commits: [
				...(live.commits ?? []),
				...report.commits.map(commit => ({ ...commit, revision: target.revision, at })),
			].slice(-200),
			...(report.commits.length === 0 && report.tasks.length === 0
					&& !report.outstanding?.some(item => item.outcome !== "dropped")
				? {
					noChange: [
						...(live.noChange ?? []),
						{ buildId, revision: target.revision, summary: report.summary, at },
					].slice(-50),
				}
				: {}),
		};
		plan.builds = [...plan.builds.slice(0, -1), buildSchema.parse({ ...build, state: "stopped" })];
		try {
			await persistExclusive(plan, true);
		} catch {
			Object.assign(plan, previous);
			return { kind: "refused", reason: "durability" };
		}
		announceImplementation(plan);
		if (graph) {
			broadcast(plan.server, plan.id, {
				kind: "plan:lifecycle",
				ts: 0,
				...implementationLifecycle({ graph, execution: plan.execution, lifecycle }),
			});
		}
		plan.persistence.onBuildStopped?.(plan.id);
		return { kind: "accepted" };
	});
}

/** What the browser needs to show whether a living document matches its pull requests. */
export function liveSnapshot(plan: Plan, connections: Connection[]): LiveSnapshot | undefined {
	let live = plan.live;
	if (!live) return;
	let { baseSource, target: _target, commits, ...rest } = live;
	let rebuild = plan.builds.findLast(build => build.kind === "rebuild");
	let unfinished = outstandingTasks(plan).map(({ id, title, state, blocker }) => ({
		id,
		title,
		state,
		...(blocker ? { blocker } : {}),
	}));
	return {
		...structuredClone(rest),
		commits: structuredClone(commits ?? []),
		...(unfinished.length ? { outstandingTasks: unfinished } : {}),
		...(rebuild ? { rebuild: structuredClone(rebuild) } : {}),
		outOfSync: source(plan) !== baseSource,
		builderConnected: connections.some(connection =>
			connection.owner === live.user && connection.source.repositoryId === live.repositoryId
		),
	};
}
