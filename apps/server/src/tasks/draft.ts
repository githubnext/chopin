import { implementationLifecycle } from "./lifecycle";
import { implementationReadiness } from "./plan-graphs";
import type { Plan } from "../plan/service";

/** Why the Planner cannot be asked for tasks now, if it cannot. */
export function draftRefusal(plan: Plan): string | undefined {
	let ready = implementationReadiness(plan, plan.revision);
	if (!ready.ok) return `resolve ${ready.blockers.join(" and ")} first`;
	if (
		plan.execution
		|| plan.builds.some(build => ["queued", "starting", "running"].includes(build.state))
	) {
		return "implementation is already active";
	}
}

/**
 * The model input for a task draft, and the line Chat shows instead of it.
 *
 * Prepared from the plan rather than the asker, so a client cannot choose what
 * the Planner is told. A graph returned for changes carries its reason along.
 * A one-click `build` starts the tasks as soon as they are saved, so the Planner
 * must not report them as waiting for approval.
 */
export function draftInstruction(
	plan: Plan,
	handle: string,
	build = false,
): { text: string; said: string } {
	let close = build
		? "Do not approve or start implementation yourself: Chopin approves and starts these tasks automatically once they are saved, so do not describe them as unapproved or unstarted."
		: "Do not approve or start implementation.";
	let graph = plan.graph?.versions.at(-1);
	if (!graph) {
		return {
			text:
				`Prepare an implementation graph for this settled plan. Read the current document and graph, then use edit_implementation_graph to create small reviewable tasks, acceptance criteria and explicit dependencies. ${close}`,
			said: `@${handle} asked Chopin to break the plan into tasks.`,
		};
	}
	let run = plan.graph
		? implementationLifecycle({
			graph: plan.graph,
			execution: plan.execution,
			lifecycle: plan.lifecycle,
		}).history.findLast(item =>
			item.run.graphVersion === graph.number && item.run.graphRevision === graph.revision
		)
		: undefined;
	let returned = run?.outcome.kind === "revision_requested"
		? ` The last build was returned for changes: ${run.outcome.reason}`
		: "";
	return {
		text:
			`Revise the implementation graph for review. The displayed graph version ${graph.number} is bound to document revision ${graph.planRevision}; the displayed document revision is ${plan.revision}.${returned} Read the latest document and graph, then use edit_implementation_graph to save a draft against the latest document revision. Preserve valid task goals, acceptance criteria and dependencies. If the tasks are still correct, replace an existing task unchanged to refresh the graph's document binding. Do not stop at summarizing an already-approved graph: approval does not make an older document revision current. ${close}`,
		said: `@${handle} asked Chopin to update the tasks.`,
	};
}
