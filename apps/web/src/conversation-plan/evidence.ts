import type { ConversationPlan, Question } from "@chopin/protocol";

export type EvidenceItem = {
	id: string;
	kind: "reason" | "constraint";
	text: string;
	sources: ConversationPlan.SourceRef[];
};

export type EvidenceRow = {
	/** Absent for evidence about the question as a whole. */
	optionId?: string;
	label: string;
	origin: "chat" | "planner" | "human";
	supporters: string[];
	opposers: string[];
	items: EvidenceItem[];
	rationale?: string;
	source?: ConversationPlan.SourceRef;
};

export function evidenceRows(
	thread: ConversationPlan.Thread,
	meta: Question.CardMeta,
	cardOptions?: Pick<Question.Option, "id" | "label">[],
): EvidenceRow[] {
	let options = thread.contributions.filter(contribution => contribution.kind === "option");
	let optionById = new Map<string, ConversationPlan.Contribution>();
	for (let option of options) optionById.set(option.id, option);
	let orderedOptions = cardOptions
		? cardOptions.flatMap(cardOption => {
			let option = optionById.get(cardOption.id);
			if (option) return [option];
			let origin = meta.optionOrigins[cardOption.id];
			return origin?.origin === "planner" && (origin.rationale || origin.source)
				? [{ id: cardOption.id, text: cardOption.label }]
				: [];
		})
		: options;
	let rows: EvidenceRow[] = orderedOptions.map(option => {
		let origin = meta.optionOrigins[option.id]?.origin ?? "chat";
		let rationale = origin === "planner" ? meta.optionOrigins[option.id]?.rationale : undefined;
		let source = origin === "planner" ? meta.optionOrigins[option.id]?.source : undefined;
		return {
			optionId: option.id,
			label: option.text,
			origin,
			supporters: [],
			opposers: [],
			items: [],
			...(rationale !== undefined ? { rationale } : {}),
			...(source ? { source } : {}),
		};
	});
	let rowByOptionId = new Map<string, EvidenceRow>();
	for (let row of rows) {
		if (row.optionId) rowByOptionId.set(row.optionId, row);
	}

	for (let stance of thread.stances) {
		if (!stance.optionId) continue;
		let row = rowByOptionId.get(stance.optionId);
		if (!row) continue;
		let handles = stance.position === "support"
			? row.supporters
			: stance.position === "oppose"
			? row.opposers
			: undefined;
		if (handles && !handles.includes(stance.participant)) handles.push(stance.participant);
	}

	let questionItems: EvidenceItem[] = [];
	for (let contribution of thread.contributions) {
		if (contribution.kind === "option") continue;
		let item: EvidenceItem = {
			id: contribution.id,
			kind: contribution.kind,
			text: contribution.text,
			sources: contribution.sources,
		};
		let row = contribution.targetId && contribution.targetId !== thread.id
			? rowByOptionId.get(contribution.targetId)
			: undefined;
		if (row) row.items.push(item);
		else questionItems.push(item);
	}

	if (questionItems.length) {
		rows.push({
			label: thread.question,
			origin: "chat",
			supporters: [],
			opposers: [],
			items: questionItems,
		});
	}

	return rows;
}

export function hasEvidence(rows: EvidenceRow[]): boolean {
	return rows.some(row =>
		row.supporters.length > 0
		|| row.opposers.length > 0
		|| row.items.length > 0
		|| Boolean(row.rationale)
		|| Boolean(row.source)
	);
}
