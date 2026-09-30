import * as Jobs from "./jobs";
import type { Job } from "./jobs";
import type { PlannerJobDeps } from "./planner-job-types";

/** Settle a stopped coordinator's running job before reusing its in-memory plan. */
export async function interruptPlannerJobs(
	deps: Pick<
		PlannerJobDeps,
		"plan" | "exclusive" | "persist" | "publishJobs" | "publishMeta" | "onError"
	>,
): Promise<boolean> {
	let interrupted: Job | undefined;
	await deps.exclusive(async () => {
		let previous = deps.plan.conversationPlanJobs;
		interrupted = previous.find(job => job.status === "running");
		if (!interrupted) return;
		deps.plan.conversationPlanJobs = Jobs.restore(previous);
		try {
			await deps.persist();
		} catch (error) {
			deps.plan.conversationPlanJobs = previous;
			throw error;
		}
	});
	if (!interrupted) return false;
	let report = (error: unknown) => {
		try {
			if (deps.onError) deps.onError(error);
			else console.error("[conversation-plan] could not publish interrupted Planner job:", error);
		} catch (reportError) {
			console.error("[conversation-plan] Planner job error reporting failed:", reportError);
		}
	};
	try {
		deps.publishJobs(deps.plan.conversationPlanJobs);
	} catch (error) {
		report(error);
	}
	if (interrupted.target !== "document") {
		try {
			deps.publishMeta(interrupted.target);
		} catch (error) {
			report(error);
		}
	}
	return true;
}
