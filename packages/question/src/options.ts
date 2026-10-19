/**
 * Growing a decision.
 *
 * The one way a definition changes after it is asked: people add options.
 * The definition and the shared draft change together, because the draft's
 * shape is derived from the definition and `read` rejects any mismatch.
 */

import { crdt, read } from "./draft";
import * as limits from "./limits";
import { appendCriterion, decision } from "./schema";

import type { Model } from "./draft";
import type { Criterion, DecisionDefinition, Option } from "./schema";

export type Added =
	| { ok: true; definition: DecisionDefinition; model: Model; option: Option }
	| { ok: false; reason: "full" | "duplicate" | "invalid"; message: string };

export function addOption(
	definition: DecisionDefinition,
	model: Model,
	id: string,
	label: string,
): Added {
	let question = definition.questions[0]!;
	if (question.response === "text") {
		return { ok: false, reason: "invalid", message: "Written answers do not have options" };
	}
	let text = label.trim();
	if (!text) return { ok: false, reason: "invalid", message: "An option needs a label" };
	if (text.length > limits.MAX_NEW_LABEL) {
		return {
			ok: false,
			reason: "invalid",
			message: `An option label is at most ${limits.MAX_NEW_LABEL} characters`,
		};
	}
	if (question.options.length >= limits.MAX_DECISION_OPTIONS) {
		return {
			ok: false,
			reason: "full",
			message: `A decision holds at most ${limits.MAX_DECISION_OPTIONS} options`,
		};
	}
	let folded = text.toLowerCase();
	if (question.options.some(option => option.label.trim().toLowerCase() === folded)) {
		return { ok: false, reason: "duplicate", message: "That is already an option" };
	}
	if (question.options.some(option => option.id === id)) {
		return { ok: false, reason: "duplicate", message: "That option ID already exists" };
	}

	let option: Option = { id, label: text, description: "" };
	let next = decision({ questions: [{ ...question, options: [...question.options, option] }] });

	let copy = model.clone();
	copy.api.obj([question.id, "options"]).set({ [id]: crdt.schema.val(crdt.schema.con(false)) });
	copy.api.flush();
	read(copy, next);

	return { ok: true, definition: next, model: copy, option };
}

export type CriterionAdded =
	| { ok: true; definition: DecisionDefinition; model: Model; criterion: Criterion }
	| { ok: false; reason: "full" | "duplicate" | "invalid"; message: string };

/**
 * Append a criterion. The draft's shape does not change: its `marks` object already exists
 * and cells are created lazily, so existing drafts and marks stay valid.
 */
export function addCriterion(
	definition: DecisionDefinition,
	model: Model,
	id: string,
	label: string,
): CriterionAdded {
	let question = definition.questions[0]!;
	let result = appendCriterion(
		definition,
		{ question: question.id, key: "x".repeat(8), label },
		id,
	);
	if (!result.ok) return result;

	let copy = model.clone();
	try {
		read(copy, result.definition);
	} catch {
		return { ok: false, reason: "invalid", message: "This draft cannot hold criteria" };
	}
	return { ok: true, definition: result.definition, model: copy, criterion: result.criterion };
}
