import * as Question from "@chopin/question";

import type { Definition } from "@chopin/question";
import type { Questions } from "./store-types";

/** Reopen the same card with a fresh draft and no waiting Planner turn. */
export function reopen(
	questions: Questions,
	id: string,
	definition: Definition,
	widget?: string,
): void {
	if (questions.open.has(id)) Question.reject("Questionnaire is already open");
	let accepted = Question.identified(definition);
	let model = Question.create(accepted);
	Question.read(model, accepted);
	questions.closed.delete(id);
	questions.open.set(id, {
		id,
		definition: accepted,
		...(widget ? { widget } : {}),
		model,
		revision: 0,
		presence: new Map(),
		editors: new Set(),
	});
}
