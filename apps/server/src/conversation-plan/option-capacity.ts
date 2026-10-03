import { limits } from "@chopin/question";
import type { Plan } from "../plan/service";
import type { Record } from "../questions/records";
import { MAX_CONTRIBUTIONS } from "./validation-fields";

type Capacity = Pick<Plan, "conversationPlanPendingEffects" | "pendingCardActions" | "records"> & {
	conversationPlan: Pick<Plan["conversationPlan"], "threads" | "events">;
};
type Budget = { key: string; used: number; limit: number; message: string; reason?: "duplicate" };

export class OptionCapacityError extends Error {
	constructor(message: string, readonly reason: "full" | "duplicate" = "full") {
		super(message);
	}
}

/** Accepted option work owns its slot until the record or thread contains its ID. */
export function assertOptionCapacity(plan: Capacity & Partial<Pick<Plan, "persistence">>): void {
	let previous: Budget[] | undefined;
	for (let budget of budgets(plan)) {
		if (budget.used <= budget.limit) continue;
		if (!previous) {
			// Existing durable excess must not make unrelated document writes unavailable.
			let saved = plan.persistence?.committedSidecar as {
				conversationPlan?: Capacity["conversationPlan"];
				conversationPlanPendingEffects?: Capacity["conversationPlanPendingEffects"];
				pendingCardActions?: Capacity["pendingCardActions"];
				questions: Record[];
			} | undefined;
			previous = saved
				? budgets({
					conversationPlan: saved.conversationPlan ?? { threads: [], events: [] },
					conversationPlanPendingEffects: saved.conversationPlanPendingEffects ?? [],
					pendingCardActions: saved.pendingCardActions ?? [],
					records: new Map(saved.questions.map(record => [record.id, record])),
				})
				: [];
		}
		if (budget.used <= (previous.find(item => item.key === budget.key)?.used ?? 0)) continue;
		throw new OptionCapacityError(budget.message, budget.reason);
	}
}

function budgets(plan: Capacity): Budget[] {
	let additions = plan.conversationPlanPendingEffects.filter(effect =>
		effect.kind === "add-option"
	);
	if (
		!additions.length && !plan.pendingCardActions.some(action => action.kind === "option-added")
	) return [];
	let triggers = new Set(additions.map(effect => effect.trigger));
	let humanOptions = new Map<string, string>();
	for (let event of additions.length ? plan.conversationPlan.events : []) {
		if (triggers.has(event.id) && event.origin === "human" && event.type === "option.added") {
			humanOptions.set(event.id, event.contribution.id);
		}
	}
	let result: Budget[] = [];
	for (let thread of plan.conversationPlan.threads) {
		let reserved = new Set<string>();
		for (let action of plan.pendingCardActions) {
			if (
				action.kind === "option-added" && action.threadId === thread.id
				&& !thread.contributions.some(item => item.id === action.optionId)
			) reserved.add(action.optionId);
		}
		result.push({
			key: JSON.stringify([thread.id, "contributions"]),
			used: thread.contributions.length + reserved.size,
			limit: MAX_CONTRIBUTIONS,
			message: "This discussion has reached its contribution limit",
		});
		let pending = additions.filter(effect =>
			effect.threadId === thread.id && humanOptions.get(effect.trigger) === effect.optionId
		);
		if (!pending.length) continue;
		let record = thread.questionnaireId && plan.records.get(thread.questionnaireId);
		if (!record || !["open", "reopened"].includes(record.status)) continue;
		let options = record.definition.questions[0]?.options ?? [];
		let byId = new Map(options.map(option => [option.id, option.label]));
		for (let effect of pending) {
			if (!byId.has(effect.optionId)) byId.set(effect.optionId, effect.label);
		}
		let labels = new Map<string, number>();
		for (let text of byId.values()) {
			let label = text.trim().toLowerCase();
			labels.set(label, (labels.get(label) ?? 0) + 1);
		}
		result.push({
			key: JSON.stringify([thread.id, "options"]),
			used: byId.size,
			limit: limits.MAX_DECISION_OPTIONS,
			message: "This card is full, including options waiting to be added",
		});
		for (let [label, used] of labels) {
			result.push({
				key: JSON.stringify([thread.id, "label", label]),
				used,
				limit: 1,
				message: "This option is already on the card",
				reason: "duplicate",
			});
		}
	}
	return result;
}
