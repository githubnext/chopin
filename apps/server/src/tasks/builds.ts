import { z } from "zod";
import { approveGraph } from "./graphs";
import { implementationReadiness } from "./plan-graphs";
import { claimEligibility } from "./lifecycle";
import { announceImplementation } from "./notifications";
import { drain, exclusive, persistExclusive, source } from "../plan/service";
import type { Plan } from "../plan/service";
import type { Connection } from "../experiments/connections";
import type { BuildRequest, CheckoutContext } from "@chopin/protocol/implementation";

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
	pullRequests: z.array(z.string().url()).min(1).max(100),
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
	list: (documentId: string) => Connection[];
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
 * The live build's user keeps ownership; its original workspace is preferred, and another of the
 * same user's workspaces for this document stands in once that one has gone.
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
		let usable = (connection: Connection | undefined) =>
			!!connection && connection.owner === live.user && connection.documentId === plan.id
			&& connection.source.repositoryId === live.repositoryId;
		let connection = original && connections.get(original.connectionId);
		if (!usable(connection)) connection = connections.list(plan.id).find(usable);
		if (!original || !connection || plan.builds.length >= 100) return { kind: "unavailable" };
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
		let previous = plan.builds;
		plan.builds = [...previous, build];
		try {
			await persistExclusive(plan, true);
		} catch (error) {
			plan.builds = previous;
			throw error;
		}
		announceImplementation(plan);
		return { kind: "queued", build: structuredClone(build) };
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
		let previous = plan.builds;
		plan.builds = [...previous.slice(0, -1), next];
		try {
			await persistExclusive(plan, true);
		} catch (error) {
			plan.builds = previous;
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
