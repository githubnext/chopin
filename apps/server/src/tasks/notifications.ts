import type { Plan } from "../plan/service";
import { broadcast } from "../wire";

export function implementationStatus(plan: Plan) {
	return {
		revision: plan.persistence.revision,
		hasGraph: !!plan.graph?.versions.at(-1)?.definition.tasks.length,
		locked: !!plan.execution
			|| plan.builds.some(build => ["queued", "starting", "running"].includes(build.state)),
	};
}

export function announceImplementation(plan: Plan) {
	broadcast(plan.server, plan.id, {
		kind: "plan:implementation",
		ts: 0,
		...implementationStatus(plan),
	});
}
