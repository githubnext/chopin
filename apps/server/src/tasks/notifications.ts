import { locksEditing } from "./builds";
import type { Plan } from "../plan/service";
import { broadcast } from "../wire";

export function implementationStatus(plan: Plan) {
	return {
		revision: plan.persistence.revision,
		hasGraph: !!plan.graph?.versions.at(-1)?.definition.tasks.length,
		locked: !!plan.execution || plan.builds.some(locksEditing),
	};
}

/** Last observed lock, seeded on open so a restored build can announce its release once. */
let announced = new WeakMap<Plan, boolean>();

export function rememberImplementationLock(plan: Plan): void {
	announced.set(plan, implementationStatus(plan).locked);
}

export function announceImplementation(plan: Plan) {
	let status = implementationStatus(plan);
	broadcast(plan.server, plan.id, {
		kind: "plan:implementation",
		ts: 0,
		...status,
	});
	let wasLocked = announced.get(plan);
	announced.set(plan, status.locked);
	if (wasLocked && !status.locked) {
		plan.persistence.onEditingUnlocked?.(plan.id);
	}
}
