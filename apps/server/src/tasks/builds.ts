import { z } from "zod";
import { approveGraph } from "./graphs";
import { implementationReadiness } from "./plan-graphs";
import { claimEligibility } from "./lifecycle";
import { announceImplementation } from "./notifications";
import { drain, exclusive, persistExclusive } from "../plan/service";
import type { Plan } from "../plan/service";
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
}).strict();

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
	});
}
