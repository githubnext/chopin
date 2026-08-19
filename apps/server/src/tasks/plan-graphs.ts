/** The hosted persistence boundary for implementation graphs. */

import { claim, Graphs } from "./graphs";
import { claimEligibility, implementationLifecycle, transition } from "./lifecycle";
import * as Comments from "../comments/service";
import { drain, exclusive, persistExclusive } from "../plan/service";
import { broadcast } from "../wire";

import type { Plan } from "../plan/service";
import type { ClaimInput, ClaimResult, Graph, GraphAdapter, Result } from "./graphs";
import type { LifecycleInput, LifecycleResult } from "./lifecycle";

const adapter: GraphAdapter<Plan> = {
	async transact(plan, change): Promise<Result<Graph>> {
		return exclusive(plan, async () => {
			// Reading the revisions, changing the graph, and committing its sidecar
			// state are one room operation. A plan change therefore cannot land
			// between the comparison and the durable record.
			let result = change({ graph: plan.graph, revision: plan.revision });
			if (!result.ok) return result;
			let previous = plan.graph;
			plan.graph = result.value;
			try {
				await persistExclusive(plan);
				return result;
			} catch (error) {
				plan.graph = previous;
				throw error;
			}
		});
	},
};

/** The graph service for a live hosted plan. */
export function implementationGraphs(): Graphs<Plan> {
	return new Graphs(adapter);
}

/** Drain accepted work, then durably lock one approved graph for implementation. */
export async function claimImplementation(plan: Plan, input: ClaimInput): Promise<ClaimResult> {
	if (plan.execution) {
		return claim({ graph: plan.graph, revision: plan.revision, execution: plan.execution }, input);
	}
	plan.claiming = true;
	try {
		await drain(plan);
		return await exclusive(plan, async () => {
			let version = plan.graph?.versions.at(-1);
			let eligibility = version
				&& claimEligibility(plan.lifecycle, version, input.run.id);
			if (eligibility && !eligibility.ok) {
				return { kind: "refused", reason: eligibility.reason };
			}
			let result = claim({
				graph: plan.graph,
				revision: plan.revision,
				execution: plan.execution,
			}, input);
			if (result.kind !== "started") return result;
			let previous = plan.graph;
			plan.graph = result.graph;
			plan.execution = result.run;
			try {
				await persistExclusive(plan);
				return result;
			} catch {
				plan.graph = previous;
				plan.execution = undefined;
				return { kind: "refused", reason: "durability" };
			}
		});
	} finally {
		plan.claiming = false;
	}
}

/** Persist one lifecycle transition before publishing its projection. */
export function reportImplementationLifecycle(
	plan: Plan,
	input: LifecycleInput,
): Promise<LifecycleResult> {
	return exclusive(plan, async () => {
		if (!plan.graph) return { kind: "refused", reason: "inactive" };
		let result = transition({
			graph: plan.graph,
			execution: plan.execution,
			lifecycle: plan.lifecycle,
		}, input);
		if (result.kind !== "accepted") return result;
		let previous = {
			graph: plan.graph,
			execution: plan.execution,
			lifecycle: plan.lifecycle,
		};
		plan.graph = result.state.graph;
		plan.execution = result.state.execution;
		plan.lifecycle = result.state.lifecycle;
		try {
			await persistExclusive(plan);
		} catch {
			plan.graph = previous.graph;
			plan.execution = previous.execution;
			plan.lifecycle = previous.lifecycle;
			return { kind: "refused", reason: "durability" };
		}
		broadcast(plan.server, plan.id, {
			kind: "plan:lifecycle",
			ts: 0,
			...implementationLifecycle(result.state),
		});
		return result;
	});
}

/** Whether the settled plan can be turned into implementation work. */
export function implementationReadiness(
	plan: Plan,
	revision: unknown,
): { ok: true; revision: number } | { ok: false; blockers: string[] } {
	let blockers: string[] = [];
	if ([...plan.records.values()].some(record => record.status === "open")) {
		blockers.push("unanswered questionnaires");
	}
	if (Comments.outstanding(plan).length > 0) {
		blockers.push("accepted comments awaiting plan changes");
	}
	if (typeof revision !== "number" || !Number.isInteger(revision) || revision !== plan.revision) {
		blockers.push("invalid plan revision");
	}
	return blockers.length > 0 ? { ok: false, blockers } : { ok: true, revision: plan.revision };
}
