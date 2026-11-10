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
export type PlannerTurn = HarnessV1PromptTurnOptions & { thinkingLevel?: string };

let started = new AsyncLocalStorage<{ thinkingLevel: string | undefined }>();

/** Runs `start`, the call that begins a turn, so the turn it gives the harness carries `thinkingLevel`. */
export function startingTurn<T>(thinkingLevel: string | undefined, start: () => T): T {
	return started.run({ thinkingLevel }, start);
}

/** Puts the level a turn was started with on the turn the harness is given; none where there was none. */
export function carryingThinkingLevel<T extends HarnessV1>(harness: T): T {
	return {
		...harness,
		async doStart(options: HarnessV1StartOptions) {
			let session = await harness.doStart(options);
			return {
				...session,
				doPromptTurn: async turn => {
					let thinkingLevel = started.getStore()?.thinkingLevel;
					return session.doPromptTurn(
						thinkingLevel === undefined ? turn : { ...turn, thinkingLevel } as PlannerTurn,
					);
				},
			} satisfies HarnessV1Session;
		},
	} as T;
}
