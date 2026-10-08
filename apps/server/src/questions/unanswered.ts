type JsonObject = { [key: string]: unknown };

function object(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as JsonObject
		: undefined;
}

function questionId(question: unknown): string {
	let id = object(question)?.id;
	return typeof id === "string" ? id : "";
}

/** Unanswered questions across stored decision records, matching the Decisions tab. */
export function unansweredDecisions(records: unknown): number {
	if (!Array.isArray(records)) return 0;
	let total = 0;
	for (let entry of records) {
		let record = object(entry);
		let questions = object(record?.definition)?.questions;
		if (!record || !Array.isArray(questions)) continue;
		if (record.status === "reopened") {
			total += questions.length;
			continue;
		}
		if (record.status !== "open") continue;
		let answers = object(record.answers);
		total += questions.filter(question => !answers || !Object.hasOwn(answers, questionId(question)))
			.length;
	}
	return total;
}

export function sidecarUnansweredDecisions(sidecar: unknown): number {
	return unansweredDecisions(object(sidecar)?.questions);
}
