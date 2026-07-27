/**
 * What each question concerns, and what answering it produced.
 *
 * Two relationships per question, both pointing at prose: `subject` is what
 * the question is about, `result` is the passage the answer caused to be
 * written. They are separate because they move independently — an answer can
 * be rewritten without the question changing meaning, and the passage a
 * decision produced is rarely the passage that prompted it.
 *
 * A relationship is either trustworthy or pending. Pending is not an error: it
 * says the agent has not reviewed this since the plan last changed, which is
 * exactly the state a reader should be told about rather than shown a link
 * that may point somewhere stale.
 */

import type { Plan } from "@chopin/protocol";
import type { Definition } from "@chopin/question";
import type { Record as Question } from "./service";

export type Relation = "subject" | "result";

export type Pending = {
	widget: string;
	question: string;
	relation: Relation;
	reason: Plan.AnchorReason;
};

function empty(pending: boolean, reason?: Plan.AnchorReason): Plan.AnchorSet {
	return { anchors: [], pending, ...(reason ? { reason } : {}) };
}

function ids(definition: Definition): string[] {
	return definition.questions.map(question => question.id);
}

/**
 * A questionnaire's relationships, with an entry for every question it asks.
 *
 * One that has never been anchored still gets a full set, so a reader is told
 * why nothing highlights rather than having to infer it from an absence. An
 * unanswered question has no result to point at yet, which is not pending —
 * there is nothing outstanding until there is an answer.
 */
export function read(record: Question): Plan.WidgetAnchors {
	if (record.anchors) return structuredClone(record.anchors);

	let answered = record.status === "answered";
	let questions: { [id: string]: Plan.QuestionAnchors } = {};
	for (let id of ids(record.definition)) {
		questions[id] = {
			subject: empty(true, "missing"),
			result: empty(answered, answered ? "missing" : undefined),
		};
	}
	return { widget: record.id, questions };
}

/**
 * Mark every result as needing review.
 *
 * Called when the plan changes or an answer does. The passage a decision
 * produced is the thing most likely to have been rewritten, and a link to
 * where it used to be is worse than an admission that nobody has checked.
 */
export function invalidate(record: Question, reason: Plan.AnchorReason): Plan.WidgetAnchors {
	let value = read(record);
	if (record.status !== "answered") return value;

	for (let question of Object.values(value.questions)) {
		question.result = { ...question.result, pending: true, reason };
	}
	return value;
}

/** Everything the agent still owes a review on. */
export function pending(record: Question): Pending[] {
	let value = read(record);
	let out: Pending[] = [];

	for (let [question, anchors] of Object.entries(value.questions)) {
		for (let relation of ["subject", "result"] as const) {
			let state = anchors[relation];
			if (!state.pending) continue;
			out.push({
				widget: value.widget,
				question,
				relation,
				reason: state.reason ?? "missing",
			});
		}
	}
	return out;
}

/** Replace one relationship, and consider it reviewed. */
export function set(
	value: Plan.WidgetAnchors,
	question: string,
	relation: Relation,
	anchors: Plan.Anchor[],
): Plan.WidgetAnchors {
	let existing = value.questions[question];
	if (!existing) return value;

	return {
		...value,
		questions: {
			...value.questions,
			[question]: {
				...existing,
				// An empty list is a real answer: reviewed, and deliberately
				// related to nothing. It is not the same as never having looked.
				[relation]: { anchors, pending: false },
			},
		},
	};
}
