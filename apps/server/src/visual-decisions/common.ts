import type { VisualDecision } from "@chopin/protocol";
import * as Service from "../plan/service";
import { broadcast } from "../wire";
import type { Socket } from "../wire";
import type * as State from "./state";

export type Input<K extends VisualDecision.Incoming["kind"]> = Extract<
	VisualDecision.Incoming,
	{ kind: K }
>;
export type Lifecycle = (action: () => Promise<void>) => Promise<void>;
let claims = new WeakMap<Service.Plan, Map<string, State.Stored>>();

export function queued(
	plan: Service.Plan,
	action: () => Promise<void>,
	lifecycle?: Lifecycle,
): Promise<void> {
	return lifecycle
		? lifecycle(() => Service.exclusive(plan, action))
		: Service.exclusive(plan, action);
}

export function claimed(plan: Service.Plan): Map<string, State.Stored> {
	let current = claims.get(plan);
	if (!current) claims.set(plan, current = new Map());
	return current;
}

export function fields(raw: object, names: string[]): void {
	if (Object.keys(raw).some(key => !["kind", "ts", "rid", ...names].includes(key))) {
		throw new Error("Invalid visual decision request");
	}
}

export function writable(plan: Service.Plan, ws: Socket): void {
	if (!ws.data.canEdit || ws.data.closed || ws.data.room !== plan.id) {
		throw new Error("Repository write access is required");
	}
	if (Service.implementationActive(plan)) throw new Error("Implementation is active");
}

export function changed(plan: Service.Plan, state: VisualDecision.State): void {
	try {
		broadcast(plan.server, plan.id, { kind: "visual-decision:changed", ts: 0, state });
	} catch (error) {
		console.error("[visual-decisions] could not announce accepted values:", error);
	}
}
