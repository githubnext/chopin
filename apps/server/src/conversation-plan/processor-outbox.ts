import { effectsFor, MAX_EFFECTS, recoverable, runEffects } from "./effects";
import type { Dependencies, EffectCommands } from "./processor-types";
import { appendEffects } from "./processor-fields";
// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.ts; import/export and synchronous closure wrappers only.

export function createOutbox(
	deps: Dependencies,
	plan: Dependencies["plan"],
	active: () => boolean,
	wake: () => void,
	effectCommands: EffectCommands | undefined,
) {
	let recovered = false;
	async function markApplied(key: string): Promise<void> {
		await deps.exclusive(async () => {
			if (!plan.conversationPlanPendingEffects.some(item => item.key === key)) return;
			let pending = plan.conversationPlanPendingEffects;
			let receipts = plan.conversationPlanEffects;
			plan.conversationPlanPendingEffects = pending.filter(item => item.key !== key);
			plan.conversationPlanEffects = [...receipts, key].slice(-MAX_EFFECTS);
			try {
				await deps.persist();
			} catch (error) {
				plan.conversationPlanPendingEffects = pending;
				plan.conversationPlanEffects = receipts;
				throw error;
			}
		});
	}

	async function recover(): Promise<void> {
		if (recovered) return;
		await deps.exclusive(async () => {
			if (!active()) return;
			let heldThreads = new Set(
				plan.pendingCardActions.filter(action =>
					["decided", "reopened", "discarded"].includes(action.kind)
				).map(action => action.threadId),
			);
			let historical = plan.conversationPlan.events.filter(event =>
				!heldThreads.has(event.threadId)
				&& (event.type === "settle.suggested" || event.type === "settle.agreed"
					|| event.type === "settle.deferred" || event.type === "settle.resumed"
					|| event.type === "stance.changed")
			);
			let advisory = effectsFor(historical, plan.conversationPlan, undefined, plan.records)
				.filter(effect =>
					effect.kind === "suggest" || effect.kind === "prompt"
					|| effect.kind === "defer-prompt"
				);
			let missing = [
				...effectsFor(
					recoverable(plan.conversationPlan),
					plan.conversationPlan,
					undefined,
					plan.records,
				),
				...advisory,
			]
				.filter(effect =>
					!plan.conversationPlanPendingEffects.some(item => item.key === effect.key)
					&& !plan.conversationPlanEffects.includes(effect.key)
				);
			if (missing.length === 0) return;
			let previous = plan.conversationPlanPendingEffects;
			plan.conversationPlanPendingEffects = appendEffects(plan, missing);
			try {
				await deps.persist();
			} catch (error) {
				plan.conversationPlanPendingEffects = previous;
				throw error;
			}
		});
		recovered = true;
	}

	async function drainEffects(): Promise<void> {
		while (active()) {
			let commands = effectCommands;
			if (!commands) return;
			let snapshot = await deps.exclusive(async () =>
				structuredClone(plan.conversationPlanPendingEffects)
			);
			if (snapshot.length === 0) return;
			let completed = await runEffects({
				...commands,
				applied: key => plan.conversationPlanEffects.includes(key),
				markApplied,
			}, snapshot);
			if (completed === 0) return;
		}
	}

	function setEffects(commands: EffectCommands): void {
		effectCommands = commands;
		wake();
	}
	return { markApplied, recover, drainEffects, setEffects };
}
