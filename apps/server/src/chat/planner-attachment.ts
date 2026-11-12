import type { Session } from "@chopin/protocol";

/**
 * What the room is told of a document's Planner: who holds it, or, when nobody does, whose machine
 * has been asked to start it (`starting`) and which machine that is, with the launch it waits on once
 * an earlier one has exited before attaching, and why its backend keeps failing once it has more
 * than once in a row.
 */
export function plannerAttachment(
	held: Session.PlannerAttachment,
	starting:
		| {
			login: string;
			machineId?: string;
			attempt?: number;
			failure?: Session.PlannerStartFailure;
		}
		| undefined,
): Session.PlannerAttachment {
	if (held.state !== "none" || !starting) return held;
	return {
		state: "starting",
		login: starting.login,
		...(starting.machineId === undefined ? {} : { machine: starting.machineId }),
		...(starting.attempt === undefined ? {} : { attempt: starting.attempt }),
		...(starting.failure ? { failure: starting.failure } : {}),
	};
}
