/**
 * Turning a draft into a decision.
 *
 * Submission is all-or-nothing: every question must be answered, because a
 * partial result would leave the agent guessing which gaps were deliberate.
 */

import { answered } from "./draft";

import type { Drafts } from "./draft";
import type { Answer, Definition } from "./schema";

export type Outcome =
	| { ok: true; answers: Answer[] }
	/** Names the question at fault so the UI can focus it. */
	| { ok: false; question: string; message: string };

/**
 * Derive answers from a draft.
 *
 * Answers carry the question text and chosen labels rather than identifiers:
 * the agent reads them as prose, and they stay meaningful in a transcript long
 * after the definition is gone.
 */
export function derive(definition: Definition, drafts: Drafts): Outcome {
	let answers: Answer[] = [];

	for (let question of definition.questions) {
		let draft = drafts[question.id];

		if (!answered(question, draft)) {
			return {
				ok: false,
				question: question.id,
				message: draft?.mode === "custom"
					? `${question.header} requires a custom answer`
					: `${question.header} requires an answer`,
			};
		}

		if (draft!.mode === "custom") {
			answers.push({ question: question.question, custom: draft!.custom.trim() });
			continue;
		}

		let selected = question.multiple
			? question.options.filter(option => draft!.options[option.id])
			: question.options.filter(option => option.id === draft!.choice);

		if (!question.multiple && selected.length > 1) {
			return {
				ok: false,
				question: question.id,
				message: `${question.header} accepts only one answer`,
			};
		}

		answers.push({
			question: question.question,
			choices: selected.map(option => option.label),
		});
	}

	return { ok: true, answers };
}

/** How an answer reads when projected into plan source. */
export function summarize(answer: Answer): string {
	return answer.custom ?? (answer.choices ?? []).join(", ");
}

/** The first unanswered question, for focusing the UI on submit. */
export function incomplete(definition: Definition, drafts: Drafts): string | undefined {
	for (let question of definition.questions) {
		if (!answered(question, drafts[question.id])) return question.id;
	}
	return undefined;
}
