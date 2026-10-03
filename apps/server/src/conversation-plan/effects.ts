import type { ConversationPlan } from "@chopin/protocol";
export { MAX_EFFECTS } from "./effect-fields";
export { restoreEffectOutbox } from "./effect-outbox";
export { effectsFor } from "./effect-projection";
export { runEffects } from "./effect-runner";
export type { CardTarget, Effect, EffectDeps, JobIntent } from "./effect-types";
// Extracted from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.ts.

export function recoverable(state: ConversationPlan.State): ConversationPlan.Event[] {
	let open = new Set(
		state.threads.filter(thread =>
			!thread.questionnaireId && ["exploring", "leaning", "reopened"].includes(thread.status)
		).map(thread => thread.id),
	);
	return state.events.filter(event => event.type === "thread.opened" && open.has(event.threadId));
}
