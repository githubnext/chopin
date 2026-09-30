import type { Plan } from "../plan/service";

import type { Processor } from "./service";

import { mirroredEvent } from "./card-mirror";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations/property nodes; synchronous wrappers only.
let drains = new WeakMap<Plan, Promise<void>>();

export async function mirrorCard(plan: Plan, processor: Processor): Promise<void> {
	let existing = drains.get(plan);
	if (existing) return existing;
	let succeeded = false;
	let operation = (async () => {
		while (plan.pendingCardActions.length > 0) {
			let action = plan.pendingCardActions[0]!;
			await processor.record(state => {
				let thread = state.threads.find(item => item.id === action.threadId);
				if (!thread) throw new Error("card mirror thread is missing");
				return mirroredEvent(thread, action);
			}, action.id);
		}
		succeeded = true;
	})();
	drains.set(plan, operation);
	try {
		await operation;
	} finally {
		if (drains.get(plan) === operation) drains.delete(plan);
		if (succeeded && plan.pendingCardActions.length > 0) {
			queueMicrotask(() => {
				void mirrorCard(plan, processor).catch(error =>
					console.error("[conversation-plan] could not mirror a card action:", error)
				);
			});
		}
	}
}

export async function wakeCardMirror(plan: Plan, processor: Processor): Promise<void> {
	processor.wake();
	await mirrorCard(plan, processor);
}
