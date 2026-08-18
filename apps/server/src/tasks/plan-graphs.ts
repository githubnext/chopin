/** The hosted persistence boundary for implementation graphs. */

import { Graphs } from "./graphs";
import * as Comments from "../comments/service";
import { exclusive, persistExclusive } from "../plan/service";

import type { Plan } from "../plan/service";
import type { Graph, GraphAdapter, Result } from "./graphs";

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
