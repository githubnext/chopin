/** Durable decision-card fields and legacy questionnaire defaults. */

import { limits as dialectLimits } from "@chopin/dialect";
import { invalid, object, STATUSES, text, unix } from "./record-fields";
import {
	answers,
	choices,
	editors,
	history,
	optionOrigins,
	options,
	prose,
} from "./record-validation";
import type { Record } from "./record-types";

export { matchesQuestionSource, questionMentionsOption } from "./record-provenance";
export type { DecisionEntry, OptionOrigin, Record } from "./record-types";

export function isOpenStatus(status: Record["status"]): boolean {
	return status === "open" || status === "reopened";
}

/** Fill only fields that did not exist on stored Planner questionnaires. */
export function normalizeRecord(raw: unknown): Record {
	let value = object(raw);
	text(value.id);
	if (!STATUSES.has(value.status as string)) invalid();
	let pending = value.origin === "conversation" && typeof value.threadId === "string"
		&& !!value.threadId.trim()
		&& (value.status === "open" || value.status === "reopened" || value.status === "discarded");
	let known = options(value.definition, pending);
	if (Object.hasOwn(value, "resolver")) text(value.resolver);
	if (Object.hasOwn(value, "at")) unix(value.at);
	if (
		Object.hasOwn(value, "origin") && value.origin !== "planner"
		&& value.origin !== "conversation"
	) invalid();
	if (Object.hasOwn(value, "threadId")) text(value.threadId, dialectLimits.MAX_ID);
	if (Object.hasOwn(value, "owner")) text(value.owner);
	if (Object.hasOwn(value, "decidedAt")) unix(value.decidedAt);
	if (Object.hasOwn(value, "choices")) choices(value.choices, known);
	if (Object.hasOwn(value, "answers")) answers(value.answers, known);
	if (Object.hasOwn(value, "history")) history(value.history, known);
	if (Object.hasOwn(value, "prose")) prose(value.prose);
	if (Object.hasOwn(value, "optionOrigins")) {
		optionOrigins(
			value.optionOrigins,
			new Set(known.options.keys()),
			value.origin === "conversation" && typeof value.threadId === "string",
		);
	}
	if (Object.hasOwn(value, "editors")) editors(value.editors);
	let record = value as Record;
	return {
		...record,
		origin: Object.hasOwn(value, "origin") ? record.origin : "planner",
		history: Object.hasOwn(value, "history") ? record.history : [],
		optionOrigins: Object.hasOwn(value, "optionOrigins") ? record.optionOrigins : {},
		editors: Object.hasOwn(value, "editors") ? record.editors : [],
		...(!Object.hasOwn(value, "owner") && record.resolver !== undefined
			? { owner: record.resolver }
			: {}),
		...(record.status === "answered" && !Object.hasOwn(value, "decidedAt")
				&& record.at !== undefined
			? { decidedAt: record.at }
			: {}),
	};
}
