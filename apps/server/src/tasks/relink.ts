import * as Questions from "../questions/service";
import { implementationActive } from "../plan/service";
import type { Plan } from "../plan/service";

type Pending = ReturnType<typeof Questions.outstanding>[number];

/**
 * Decision links a first build's editing lock left pending.
 *
 * `edit_plan` puts answered decisions back under review and only `anchor_plan` clears them, but
 * `anchor_plan` is refused while a first build locks editing. A Planner turn that edited just
 * before a build was queued therefore leaves its cards on "Linking…" with nothing to retry it.
 * Living documents only: flag-off behaviour is unchanged. Rebuilds never lock, so anchoring
 * during one already succeeds.
 */
export function pendingLinks(plan: Plan): Pending[] {
	if (!plan.persistence.liveBuild || implementationActive(plan)) return [];
	return Questions.outstanding(plan);
}

/** The instruction for the Planner turn that re-attempts those links. */
export function relinkInstruction(pending: Pending[]): string {
	let listed = pending.map(item => `- widget ${item.widget}, question ${item.question}`);
	return [
		"The build has released the document, so decisions can be linked to their prose again.",
		"These answered decisions are still waiting for review:",
		...listed,
		"Call read_plan, then call anchor_plan once with that revision, linking each decision to "
		+ "the blocks it produced, or an empty list if none. Do not change the document.",
	].join("\n");
}
