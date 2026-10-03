import type { LinkedCardOptions } from "./questions";
import type { Dependencies, State } from "./processor-types";
// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.ts; import/export and synchronous closure wrappers only.

export function cardCycle(plan: Dependencies["plan"], thread: State["threads"][number]) {
	let id = thread.questionnaireId;
	let record = id ? plan.records.get(id) : undefined;
	return { id, status: record?.status, generation: record?.history.length };
}

export function linkedCardOptions(plan: Dependencies["plan"], state: State): LinkedCardOptions {
	let cards = new Map<string, { cardId: string; options: Array<{ id: string; label: string }> }>();
	for (let thread of state.threads) {
		let cardId = thread.questionnaireId;
		let record = cardId && plan.records.get(cardId);
		if (
			!cardId || !record || record.threadId !== thread.id
			|| (record.status !== "open" && record.status !== "reopened")
		) continue;
		let options = record.definition.questions[0]?.options;
		if (
			!options || options.length > 10
			|| new Set(options.map(item => item.id)).size !== options.length
		) {
			continue;
		}
		cards.set(thread.id, {
			cardId,
			options: options.map(item => ({ id: item.id, label: item.label })),
		});
	}
	return cards;
}
