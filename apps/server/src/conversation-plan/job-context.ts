/**
 * Process-local Chat contexts for the member message that started a job.
 * Keep them until the document closes: an arbitrary size cap can drop the
 * original claimant while a durable job waits behind many later messages.
 */

import type * as Chat from "../chat/service";
import type { Job } from "./jobs";

type Plan = object & { chat: { owner?: { sessionId: string } } };

export function createJobContexts() {
	let byPlan = new WeakMap<Plan, Map<string, Chat.Room>>();
	return {
		remember(plan: Plan, messageId: string, context: Chat.Room): Chat.Room | undefined {
			let byMessage = byPlan.get(plan) ?? new Map<string, Chat.Room>();
			byPlan.set(plan, byMessage);
			let previous = byMessage.get(messageId);
			byMessage.set(messageId, context);
			return previous;
		},
		async accept<T>(
			plan: Plan,
			messageId: string,
			context: Chat.Room,
			commit: () => Promise<T>,
		): Promise<T> {
			let byMessage = byPlan.get(plan) ?? new Map<string, Chat.Room>();
			byPlan.set(plan, byMessage);
			let previous = byMessage.get(messageId);
			byMessage.set(messageId, context);
			try {
				return await commit();
			} catch (error) {
				if (byMessage.get(messageId) === context) {
					if (previous) byMessage.set(messageId, previous);
					else byMessage.delete(messageId);
				}
				throw error;
			}
		},
		forget(plan: Plan, messageId: string, context: Chat.Room): void {
			let byMessage = byPlan.get(plan);
			if (byMessage?.get(messageId) === context) byMessage.delete(messageId);
		},
		restore(
			plan: Plan,
			messageId: string,
			context: Chat.Room,
			previous?: Chat.Room,
		): void {
			let byMessage = byPlan.get(plan);
			if (byMessage?.get(messageId) !== context) return;
			if (previous) byMessage.set(messageId, previous);
			else byMessage.delete(messageId);
		},
		clear(plan: Plan): void {
			byPlan.delete(plan);
		},
		any(plan: Plan): Chat.Room | undefined {
			return [...(byPlan.get(plan)?.values() ?? [])].at(-1);
		},
		claim(plan: Plan, job: Job): { context: Chat.Room; claimantSessionId: string } | undefined {
			let byMessage = byPlan.get(plan);
			let triggered = byMessage?.get(job.trigger);
			let owner = plan.chat.owner?.sessionId;
			if (job.kind === "prose" && !triggered) return undefined;
			if (owner) {
				let context = triggered
					?? [...(byMessage?.values() ?? [])].find(item => item.claimantSessionId === owner);
				return context ? { context, claimantSessionId: owner } : undefined;
			}
			return triggered
				? { context: triggered, claimantSessionId: triggered.claimantSessionId }
				: undefined;
		},
	};
}
