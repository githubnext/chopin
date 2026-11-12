import { buildNotices } from "./build-notices";
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

/**
 * Build notices this plan has already seen, seeded on open with every one its stored state calls
 * for: a document opened long after its builds finished gets no line for them.
 */
let noticed = new WeakMap<Plan, Set<string>>();

export function rememberImplementationLock(plan: Plan): void {
	announced.set(plan, implementationStatus(plan).locked);
	noticed.set(plan, new Set(buildNotices(plan).map(notice => notice.id)));
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
	let post = plan.persistence.onBuildNotice;
	if (!post) return;
	let seen = noticed.get(plan) ?? new Set<string>();
	noticed.set(plan, seen);
	for (let notice of buildNotices(plan)) {
		if (seen.has(notice.id)) continue;
		seen.add(notice.id);
		post(plan.id, notice);
	}
}
