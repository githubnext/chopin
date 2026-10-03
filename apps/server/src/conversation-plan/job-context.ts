/**
 * Process-local Chat contexts for the member message that started a job.
 * Retain claimants while durable work can still use them, plus the current
 * owner and latest authenticated context for jobs without a captured trigger.
 */

import type * as Chat from "../chat/service";
import type { Job } from "./jobs";
import type { Plan as OpenPlan } from "../plan/service";
import { proseJobTrigger } from "../questions/card-actions";

type Work = Pick<
	OpenPlan,
	| "conversationPlan"
	| "conversationPlanJobs"
	| "conversationPlanPendingEffects"
	| "pendingCardActions"
>;
type Plan = Work & {
	chat: { owner?: { sessionId: string } };
	persistence: Pick<OpenPlan["persistence"], "committedSidecar">;
};

export function createJobContexts() {
	let byPlan = new WeakMap<Plan, Map<string, Chat.Room>>();
	let accepting = new WeakMap<Plan, Map<string, number>>();

	function prune(plan: Plan): void {
		let byMessage = byPlan.get(plan);
		if (!byMessage) return;
		let needed = new Set(accepting.get(plan)?.keys());
		function retain(work: Partial<Work>): void {
			for (let item of work.conversationPlan?.queue ?? []) needed.add(item.messageId);
			for (let job of work.conversationPlanJobs ?? []) {
				if (job.status === "pending" || job.status === "running" || job.status === "failed") {
					needed.add(job.trigger);
				}
			}
			for (let action of work.pendingCardActions ?? []) {
				if (action.kind === "decided") {
					needed.add(proseJobTrigger(action.cardId, action.generation));
				}
			}
			for (let effect of work.conversationPlanPendingEffects ?? []) {
				if (effect.kind === "job") needed.add(effect.intent.trigger);
				if ("source" in effect && effect.source) needed.add(effect.source.messageId);
				if ("sources" in effect) {
					for (let source of effect.sources) needed.add(source.messageId);
				}
				if ("messageId" in effect) needed.add(effect.messageId);
				if ("messageIds" in effect) {
					for (let id of effect.messageIds) needed.add(id);
				}
				if (effect.kind === "prompt") {
					for (let id of effect.sourceMessageIds ?? []) needed.add(id);
				}
				if (effect.kind === "insert-card") {
					// Linking the card creates a refine job from the original question source.
					let thread = work.conversationPlan?.threads.find(item => item.id === effect.threadId);
					let source = thread?.questionSources[0];
					if (source) needed.add(source.messageId);
				}
			}
		}
		retain(plan);
		// Live fields can remove work before its fenced commit; keep the rollback roots too.
		let committed = plan.persistence.committedSidecar;
		if (committed && typeof committed === "object" && !Array.isArray(committed)) {
			retain(committed as Partial<Work>);
		}
		let entries = [...byMessage];
		let latest = entries.at(-1);
		let owner = entries.findLast(([, context]) =>
			context.claimantSessionId === plan.chat.owner?.sessionId
		);
		if (latest) needed.add(latest[0]);
		if (owner) needed.add(owner[0]);
		for (let id of byMessage.keys()) {
			if (!needed.has(id)) byMessage.delete(id);
		}
	}

	return {
		remember(plan: Plan, messageId: string, context: Chat.Room): Chat.Room | undefined {
			let byMessage = byPlan.get(plan) ?? new Map<string, Chat.Room>();
			byPlan.set(plan, byMessage);
			let previous = byMessage.get(messageId);
			byMessage.delete(messageId);
			byMessage.set(messageId, context);
			prune(plan);
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
			let pending = accepting.get(plan) ?? new Map<string, number>();
			accepting.set(plan, pending);
			pending.set(messageId, (pending.get(messageId) ?? 0) + 1);
			byMessage.delete(messageId);
			byMessage.set(messageId, context);
			prune(plan);
			try {
				return await commit();
			} catch (error) {
				if (byMessage.get(messageId) === context) {
					if (previous) byMessage.set(messageId, previous);
					else byMessage.delete(messageId);
				}
				throw error;
			} finally {
				let count = pending.get(messageId)! - 1;
				if (count) pending.set(messageId, count);
				else pending.delete(messageId);
				prune(plan);
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
			accepting.delete(plan);
		},
		any(plan: Plan): Chat.Room | undefined {
			prune(plan);
			return [...(byPlan.get(plan)?.values() ?? [])].at(-1);
		},
		claim(plan: Plan, job: Job): { context: Chat.Room; claimantSessionId: string } | undefined {
			prune(plan);
			let byMessage = byPlan.get(plan);
			let triggered = byMessage?.get(job.trigger);
			let owner = plan.chat.owner?.sessionId;
			if (job.kind === "prose" && !triggered) return undefined;
			if (owner) {
				let context = triggered
					?? [...(byMessage?.values() ?? [])].findLast(item => item.claimantSessionId === owner);
				return context ? { context, claimantSessionId: owner } : undefined;
			}
			return triggered
				? { context: triggered, claimantSessionId: triggered.claimantSessionId }
				: undefined;
		},
	};
}
