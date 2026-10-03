import { isDeepStrictEqual } from "node:util";
import { type Effect, MAX_EFFECTS } from "./effects";
import { QUESTION_SET_VERSION } from "./question-shared";
import type { Analysis, Dependencies, State } from "./processor-types";
// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.ts; import/export and synchronous closure wrappers only.

export const MAX_PENDING_EFFECTS = MAX_EFFECTS;

export function appendEffects(plan: Dependencies["plan"], effects: readonly Effect[]): Effect[] {
	let pending = [...plan.conversationPlanPendingEffects];
	for (let effect of effects) {
		if (plan.conversationPlanEffects.includes(effect.key)) continue;
		let existing = pending.find(item => item.key === effect.key);
		if (existing) {
			if (
				effect.key === "job:heading:document"
				&& effect.kind === "job" && existing.kind === "job"
				&& effect.intent.kind === "heading" && existing.intent.kind === "heading"
			) continue;
			if (!isDeepStrictEqual(existing, effect)) {
				throw new Error("conversation effect key collision");
			}
			continue;
		}
		if (pending.length >= MAX_PENDING_EFFECTS) {
			throw new Error("conversation effect outbox is full");
		}
		pending.push(effect);
	}
	return pending;
}

export function failure(reason: string): Analysis {
	return {
		questionSetVersion: QUESTION_SET_VERSION,
		modelVersion: "unavailable",
		status: "failed",
		passes: [],
		error: reason,
	};
}

export function sameThreads(before: State, now: State): boolean {
	return before.threads.length === now.threads.length
		&& before.threads.every((thread, index) =>
			thread.id === now.threads[index]?.id && thread.version === now.threads[index]?.version
		);
}
