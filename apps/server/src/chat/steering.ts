import { PLANNER_NAME } from "@chopin/protocol/address";
import type { PlannerSession } from "../harness/session";

/** What a person is told when a message cannot reach a turn that is running. */
export const CANNOT_STEER =
	`${PLANNER_NAME} can't take messages while it works on this machine. Stop it to ask now.`;

/**
 * The way to the running turn's session for a message given to it. `ready` is the session once it
 * can take one (its first model call has been made), or nothing if the turn ends first.
 */
export type Steering = {
	turn: string;
	ready: Promise<PlannerSession | undefined>;
	open: (session: PlannerSession) => void;
	end: () => void;
};

export function steering(turn: string): Steering {
	let ready = Promise.withResolvers<PlannerSession | undefined>();
	return {
		turn,
		ready: ready.promise,
		open: session => ready.resolve(session),
		end: () => ready.resolve(undefined),
	};
}
