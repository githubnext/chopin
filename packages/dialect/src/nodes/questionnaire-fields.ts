import * as limits from "../limits";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 node declarations; import/export wrappers only.

export type Option = {
	id: string;
	label: string;
	description?: string;
};

/** `expired` is host input an earlier Chopin closed unanswered: settled, but with no answer. */
export type CardStatus = "open" | "decided" | "reopened" | "discarded" | "expired";

export type Criterion = { id: string; label: string };

/** A settled answer's matrix, keyed `optionId/criterionId`, sparse. */
export type Marks = { [cell: string]: "yes" | "partly" | "no" };

export type Previous = { choices: string[]; value?: string; by: string; at: string };

export type Question = {
	id: string;
	header: string;
	prompt: string;
	description?: string;
	multiple: boolean;
	response?: "text";
	options: Option[];
	/** Columns the options are judged against. Choice questions only. */
	criteria?: Criterion[];
	/** Projection of the settled matrix, when the question has criteria and an answer. */
	marks?: Marks;
	/** Projection of the resolved answer, when there is one. */
	answer?: string;
	/** Ids of the chosen options, when known. */
	choices?: string[];
	/** Latest decision replaced when this question was reopened. */
	previous?: Previous;
};

export type Questionnaire = {
	id: string;
	questions: Question[];
	/** Conversation thread that raised this card. Absent for Planner questions. */
	thread?: string;
	/** Absent on older documents; derive their status from answers. */
	status?: CardStatus;
	/**
	 * Who settled it, and when.
	 *
	 * On the questionnaire rather than on each answer: it resolves as a unit,
	 * so this is one fact about one moment. Absent until it is answered, and
	 * absent for good on one answered before this was written down.
	 */
	by?: string;
	/** ISO 8601. */
	at?: string;
};

export const EMPTY: Questionnaire = { id: "", questions: [] };

const STATUSES: ReadonlySet<CardStatus> = new Set([
	"open",
	"decided",
	"reopened",
	"discarded",
	"expired",
]);

export function cardStatus(value: Questionnaire): CardStatus {
	if (value.status !== undefined) {
		if (!STATUSES.has(value.status)) throw new Error("invalid questionnaire status");
		return value.status;
	}
	return value.questions.length > 0
			&& value.questions.every(question => question.answer !== undefined)
		? "decided"
		: "open";
}

const MARKS: ReadonlySet<unknown> = new Set(["yes", "partly", "no"]);

function checkCriteria(question: Partial<Question>): void {
	let hasCriteria = Object.hasOwn(question, "criteria");
	if (!hasCriteria && !Object.hasOwn(question, "marks")) return;
	let invalid = () => new Error("invalid questionnaire criteria");
	if (!hasCriteria || question.response !== undefined || !Array.isArray(question.options)) {
		throw invalid();
	}
	let criteria = question.criteria;
	if (
		!Array.isArray(criteria) || criteria.length === 0 || criteria.length > limits.MAX_CRITERIA
	) throw invalid();
	let ids = new Set<string>();
	for (let criterion of criteria) {
		if (
			!criterion || typeof criterion !== "object"
			|| typeof criterion.id !== "string" || !criterion.id || ids.has(criterion.id)
			|| typeof criterion.label !== "string" || !criterion.label.trim()
			|| criterion.label.length > limits.MAX_CRITERION_LABEL
		) throw invalid();
		ids.add(criterion.id);
	}
	if (!Object.hasOwn(question, "marks")) return;
	let marks = question.marks;
	if (!marks || typeof marks !== "object" || Array.isArray(marks) || question.answer === undefined) {
		throw invalid();
	}
	let options = new Set(question.options.map(option => option?.id));
	for (let [cell, mark] of Object.entries(marks)) {
		let slash = cell.lastIndexOf("/");
		if (
			slash < 1 || !options.has(cell.slice(0, slash)) || !ids.has(cell.slice(slash + 1))
			|| !MARKS.has(mark)
		) throw invalid();
	}
}

export function parse(value: unknown): Questionnaire {
	if (!value || typeof value !== "object") return EMPTY;
	let raw = value as Partial<Questionnaire>;
	if (
		Object.hasOwn(raw, "thread")
		&& (typeof raw.thread !== "string" || !raw.thread.trim() || raw.thread.length > limits.MAX_ID)
	) throw new Error("invalid questionnaire thread");
	if (Object.hasOwn(raw, "status") && !STATUSES.has(raw.status as CardStatus)) {
		throw new Error("invalid questionnaire status");
	}
	let questions = Array.isArray(raw.questions) ? raw.questions : [];
	for (let question of questions) {
		if (question && typeof question === "object" && Object.hasOwn(question, "response")) {
			if (
				question.response !== "text" || question.multiple !== false
				|| !Array.isArray(question.options) || question.options.length > 0
			) {
				throw new Error("invalid questionnaire text response");
			}
			if (question.choices?.length || question.previous?.choices.length) {
				throw new Error("text questionnaire cannot contain answer choices");
			}
			if (
				Object.hasOwn(question, "answer")
				&& (typeof question.answer !== "string" || !question.answer.trim()
					|| question.answer.length > limits.MAX_CUSTOM_ANSWER)
			) throw new Error("invalid questionnaire written answer");
		}
		if (question && typeof question === "object") checkCriteria(question);
		if (!question || typeof question !== "object" || !Object.hasOwn(question, "previous")) {
			continue;
		}
		let previous = question.previous;
		if (
			!previous || typeof previous !== "object" || Array.isArray(previous)
			|| !Array.isArray(previous.choices)
			|| previous.choices.length > limits.MAX_OPTIONS
			|| (previous.choices.length === 0) === (previous.value === undefined)
			|| (Object.hasOwn(previous, "value")
				&& (typeof previous.value !== "string" || !previous.value.trim()
					|| previous.value.length > limits.MAX_CUSTOM_ANSWER))
			|| typeof previous.by !== "string" || !previous.by.trim()
			|| previous.by.length > limits.MAX_HANDLE
			|| typeof previous.at !== "string" || !previous.at.trim()
			|| previous.at.length > limits.MAX_TIMESTAMP
			|| !Array.isArray(question.options)
		) throw new Error("invalid questionnaire previous decision");
		let options = new Set(question.options.map(option => option?.id));
		if (
			previous.choices.some(id => typeof id !== "string" || !options.has(id))
			|| new Set(previous.choices).size !== previous.choices.length
			|| (!question.multiple && previous.choices.length > 1)
		) throw new Error("invalid questionnaire previous choices");
	}
	return {
		id: typeof raw.id === "string" ? raw.id : "",
		questions,
		...(raw.thread === undefined ? {} : { thread: raw.thread }),
		...(raw.status === undefined ? {} : { status: raw.status }),
		...(typeof raw.by === "string" ? { by: raw.by } : {}),
		...(typeof raw.at === "string" ? { at: raw.at } : {}),
	};
}
