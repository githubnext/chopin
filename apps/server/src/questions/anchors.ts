/**
 * Where each of a questionnaire's decisions lives in the plan.
 *
 * One relationship per question. It used to be two — `subject` for what the
 * question was about, `result` for what answering it produced — on the theory
 * that they move independently. They did not: asked to tell them apart, the
 * agent anchored the first block of the result and called it the subject, in
 * every record it ever wrote. What a reader wants is the prose the decision
 * lives in, which is the one thing an accepted comment has always carried.
 *
 * The split also cost something. A subject was never derived when a question
 * was asked and never invalidated when the plan moved, so it sat permanently
 * unreviewed — which rendered as an inert link and put an entry in the agent's
 * `anchors_pending` that no amount of anchoring could clear.
 *
 * A relationship is either trustworthy or pending. Pending is not an error: it
 * says the agent has not reviewed this since the plan last changed, which is
 * exactly the state a reader should be told about rather than shown a link
 * that may point somewhere stale.
 */

import type { Plan } from "@chopin/protocol";
import type { Definition } from "@chopin/question";
import type { Record as Question } from "./service";

export type Pending = {
	widget: string;
	question: string;
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
 * unanswered question is not pending: there is no decision to place until
 * somebody has made one, and owing a review for it would be owing one forever.
 */
export function read(record: Question): Plan.WidgetAnchors {
	if (record.anchors) return folded(structuredClone(record.anchors));

	let answered = record.status === "answered";
	let questions: { [id: string]: Plan.AnchorSet } = {};
	for (let id of ids(record.definition)) {
		questions[id] = empty(answered, answered ? "missing" : undefined);
	}
	return { widget: record.id, questions };
}

/** A question as it was persisted before the two halves were folded into one. */
type Split = { subject?: Plan.AnchorSet; result?: Plan.AnchorSet };

/**
 * Bring a record written before the fold forward.
 *
 * `read` hands back what was persisted verbatim, and nothing between
 * `JSON.parse` and here checks it, so a shape change reaches the rebase as a
 * set with no `anchors` array. That does not crash the room — the carry on open
 * is guarded — which is worse: it is caught, logged, and every decision in the
 * plan quietly loses its place. The guard is shared with the comment threads,
 * so one stale question record takes their anchors down too.
 *
 * Both halves are kept. In practice the subject was a subset of the result, so
 * the union is the result; where it was not, the agent anchored the subject and
 * never got round to the other, and dropping it would lose the only placement
 * that question ever had. Review state comes from the result, which is the half
 * that was actually maintained.
 */
function folded(value: Plan.WidgetAnchors): Plan.WidgetAnchors {
	let questions: { [id: string]: Plan.AnchorSet } = {};

	for (let [id, set] of Object.entries(value.questions)) {
		let split = set as Plan.AnchorSet & Split;
		if (Array.isArray(split.anchors)) {
			questions[id] = set;
			continue;
		}

		let result = split.result ?? empty(true, "missing");
		let seen = new Set<string>();
		let anchors: Plan.Anchor[] = [];
		for (let anchor of [...result.anchors, ...(split.subject?.anchors ?? [])]) {
			if (seen.has(anchor.digest)) continue;
			seen.add(anchor.digest);
			anchors.push(anchor);
		}

		questions[id] = {
			anchors,
			pending: result.pending,
			...(result.reason ? { reason: result.reason } : {}),
		};
	}

	return { widget: value.widget, questions };
}

/**
 * Mark every placement as needing review.
 *
 * Called when the plan changes or an answer does. The prose a decision lives in
 * is the thing most likely to have been rewritten, and a link to where it used
 * to be is worse than an admission that nobody has checked.
 */
export function invalidate(record: Question, reason: Plan.AnchorReason): Plan.WidgetAnchors {
	let value = read(record);
	if (record.status !== "answered") return value;

	for (let [id, set] of Object.entries(value.questions)) {
		value.questions[id] = { ...set, pending: true, reason };
	}
	return value;
}

/** Everything the agent still owes a review on. */
export function pending(record: Question): Pending[] {
	let value = read(record);
	let out: Pending[] = [];

	for (let [question, set] of Object.entries(value.questions)) {
		if (!set.pending) continue;
		out.push({ widget: value.widget, question, reason: set.reason ?? "missing" });
	}
	return out;
}

/** Replace where a question's decision lives, and consider it reviewed. */
export function set(
	value: Plan.WidgetAnchors,
	question: string,
	anchors: Plan.Anchor[],
): Plan.WidgetAnchors {
	if (!value.questions[question]) return value;

	return {
		...value,
		questions: {
			...value.questions,
			// An empty list is a real answer: reviewed, and deliberately
			// related to nothing. It is not the same as never having looked.
			[question]: { anchors, pending: false },
		},
	};
}
