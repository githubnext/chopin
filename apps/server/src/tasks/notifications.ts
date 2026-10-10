import { locksEditing } from "./builds";
import type { Plan } from "../plan/service";
import { broadcast } from "../wire";

export function implementationStatus(plan: Plan) {
	return {
		revision: plan.persistence.revision,
		locked: !!plan.execution || plan.builds.some(locksEditing),
	};
}

/** The lock each open plan last announced, so a release is reported once. */
let announced = new WeakMap<Plan, boolean>();

export function announceImplementation(plan: Plan) {
	let status = implementationStatus(plan);
	broadcast(plan.server, plan.id, {
		kind: "plan:implementation",
		ts: 0,
		...status,
	});
	let wasLocked = announced.get(plan);
	announced.set(plan, status.locked);
	if (wasLocked && !status.locked && plan.persistence.liveBuild) {
		plan.persistence.onEditingUnlocked?.(plan.id);
	}
}
