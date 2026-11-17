import { AsyncLocalStorage } from "node:async_hooks";

import type {
	HarnessV1,
	HarnessV1PromptTurnOptions,
	HarnessV1Session,
	HarnessV1StartOptions,
} from "./harness-v1";

/**
 * The turn a Planner's harness is given: the SDK's, and the thinking level a person chose for it.
 * `HarnessAgent` builds each turn from a fixed set of fields (model, skills, instructions, tools),
 * and none of them can hold a level, so the level travels beside the call that starts the turn
 * (`startingTurn`) and `carryingThinkingLevel` puts it on the turn where the harness takes it.
 */
export type PlannerTurn = HarnessV1PromptTurnOptions & {
	thinkingLevel?: string;
	/**
	 * What this turn is told before its prompt when the prompt itself has to open with a command:
	 * an Atomic Planner session records it in the session before the command so later turns keep it.
	 */
	context?: string;
};

let started = new AsyncLocalStorage<{ thinkingLevel?: string; context?: string }>();

/**
 * Runs `start`, the call that begins a turn, so the turn it gives the harness carries
 * `thinkingLevel` and `context`.
 */
export function startingTurn<T>(
	thinkingLevel: string | undefined,
	start: () => T,
	context?: string,
): T {
	return started.run({ thinkingLevel, context }, start);
}

/** Puts the level and context a turn was started with on the turn the harness is given. */
export function carryingThinkingLevel<T extends HarnessV1>(harness: T): T {
	return {
		...harness,
		async doStart(options: HarnessV1StartOptions) {
			let session = await harness.doStart(options);
			return {
				...session,
				doPromptTurn: async turn => {
					let held = started.getStore();
					return session.doPromptTurn({
						...turn,
						...(held?.thinkingLevel !== undefined ? { thinkingLevel: held.thinkingLevel } : {}),
						...(held?.context !== undefined ? { context: held.context } : {}),
					} as PlannerTurn);
				},
			} satisfies HarnessV1Session;
		},
	} as T;
}
