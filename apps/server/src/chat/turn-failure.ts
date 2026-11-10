import type { Chat as Wire } from "@chopin/protocol";

import { PlannerReplyError } from "./reply-policy";

type Input = {
	error: unknown;
	/** What cut the turn short, as `chat.interruption` held it, read before it is cleared. */
	interruption?: string;
	/** Whether the Planner's link dropped under the reply. */
	suspended: boolean;
	/** The member message that began the turn, if one did. */
	request?: string;
	/** The child document that was open when it was sent. */
	focus?: string;
};

const TIMED_OUT = /timed?[\s-]?out|ETIMEDOUT|deadline exceeded/i;

/**
 * Why a Planner turn ended, for a client that offers the way back. `detail` is the failure's own
 * words only where they came from the model or harness: Chopin's own refusals and notices stay
 * out, so a client writes those in plain words itself.
 */
export function turnFailureOf(input: Input): Wire.TurnFailure {
	let { error, interruption } = input;
	let turn = {
		...input.request !== undefined ? { request: input.request } : {},
		...input.focus !== undefined ? { focus: input.focus } : {},
	};
	if (input.suspended) return { kind: "dropped", ...turn };
	if (interruption) {
		if (interruption.startsWith("Chopin's tool approval")) return { kind: "refused", ...turn };
		if (interruption.startsWith("Chopin's tool boundary failure")) return { kind: "tool", ...turn };
		return { kind: "error", ...turn };
	}
	if (!(error instanceof Error)) return { kind: "unreachable", ...turn };
	if (error instanceof PlannerReplyError) return { kind: "error", ...turn };
	if (error.name === "TimeoutError" || TIMED_OUT.test(error.message)) {
		return { kind: "timed-out", ...turn };
	}
	return {
		kind: "error",
		...error.message ? { detail: error.message } : {},
		...turn,
	};
}
