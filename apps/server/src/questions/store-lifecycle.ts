import * as Question from "@chopin/question";

import type { Definition } from "@chopin/question";
import type { Questions } from "./store-types";

/**
 * Reopen the same card with a fresh draft and no waiting Planner turn.
 *
 * When reopening a previously settled or closed card, the revision starts strictly
 * above every revision observed before so stale pre-reopen submits are refused.
 */
export function reopen(
	questions: Questions,
	id: string,
	definition: Definition,
	widget?: string,
	previousRevision?: number,
): void {
	if (questions.open.has(id)) Question.reject("Questionnaire is already open");
	let accepted = Question.identified(definition);
	let model = Question.create(accepted);
	Question.read(model, accepted);
	let closed = questions.closed.get(id);
	let prior = closed !== undefined && previousRevision !== undefined
		? Math.max(closed.revision, previousRevision)
		: closed?.revision ?? previousRevision;
	let revision = prior === undefined ? 0 : prior + 1;
	questions.closed.delete(id);
	questions.open.set(id, {
		id,
		definition: accepted,
		...(widget ? { widget } : {}),
		model,
		revision,
		presence: new Map(),
		editors: new Set(),
	});
}
