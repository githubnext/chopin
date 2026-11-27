/**
 * Read-only decision snapshots, status/origin filtering, and card/question ID resolution.
 *
 * Works identically on live rooms (`Store.Questions`) and stored-only documents
 * (`Store.StoredOpen[]`) without mutating collaboration state.
 */

import * as Question from "@chopin/question";

import { activeSettleDeferral } from "../conversation-plan/preference";
import { isOpenStatus } from "./records";

import type { ConversationPlan } from "@chopin/protocol";
import type { DecisionEntry, Record as DecisionRecord } from "./records";
import type { Open, Questions, StoredOpen } from "./store-types";

export const DECISION_STATUSES = [
	"open",
	"reopened",
	"answered",
	"discarded",
	"cancelled",
	"expired",
] as const;

export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DECISION_ORIGINS = ["planner", "conversation", "human"] as const;

export type DecisionOrigin = (typeof DECISION_ORIGINS)[number];

export type DecisionStatusFilter = "all" | DecisionStatus | readonly DecisionStatus[];

export type DecisionFilter = {
	status?: DecisionStatusFilter;
	origin?: DecisionOrigin;
};

export type DecisionQuestionOption = {
	id: string;
	label: string;
	description?: string;
	preview?: string;
};

export type DecisionQuestion = {
	id: string;
	header: string;
	question: string;
	description?: string;
	multiple: boolean;
	response?: "text";
	options: DecisionQuestionOption[];
};

export type DecisionOutcome = {
	by: string;
	at: number;
	answers: Record<string, string>;
	optionIds: string[];
	why?: string;
};

export type DecisionSnapshot = {
	id: string;
	status: DecisionStatus;
	origin: DecisionOrigin;
	revision: number;
	paused: boolean;
	draftInProgress: boolean;
	questions: DecisionQuestion[];
	settled?: DecisionOutcome;
	previous?: DecisionOutcome;
	historyCount: number;
};

export type DecisionCounts = {
	open: number;
	reopened: number;
	answered: number;
	discarded: number;
	cancelled: number;
	expired: number;
	total: number;
};

export type ReadDecisionsResult = {
	decisions: DecisionSnapshot[];
	decisionCounts: DecisionCounts;
};

/**
 * Whether one question's shared draft is still in its clean initial state.
 * Handles both choice questions (initial `mode === "choices"`) and written/text questions
 * (initial `mode === "custom"` with empty text).
 */
export function isDraftUntouched(
	question: Question.Item,
	draft: Question.Draft | undefined,
): boolean {
	if (!draft) return true;
	let textQuestion = question.response === "text"
		|| (!!question.verbatim && question.options.length === 0);
	if (textQuestion) {
		return draft.mode === "custom"
			&& draft.custom.length === 0
			&& draft.choice === null
			&& !Object.values(draft.options).some(Boolean);
	}
	return draft.mode === "choices"
		&& draft.choice === null
		&& draft.custom.length === 0
		&& !Object.values(draft.options).some(Boolean)
		&& Object.keys(Question.marked(draft)).length === 0;
}

/** Whether every question in a card still has an untouched shared draft. */
export function isCardDraftUntouched(
	definition: Question.Definition,
	drafts: Question.Drafts,
): boolean {
	return definition.questions.every(question => isDraftUntouched(question, drafts[question.id]));
}

function isRecordMap(
	value: Iterable<DecisionRecord> | ReadonlyMap<string, DecisionRecord>,
): value is ReadonlyMap<string, DecisionRecord> {
	return typeof (value as ReadonlyMap<string, DecisionRecord>).get === "function"
		&& typeof (value as ReadonlyMap<string, DecisionRecord>).values === "function";
}

/**
 * Resolve either a decision card ID or any question ID within a card to its record.
 * Returns undefined when no card matches.
 */
export function resolveDecisionRecord(
	records: Iterable<DecisionRecord> | ReadonlyMap<string, DecisionRecord>,
	decisionId: string,
): DecisionRecord | undefined {
	if (isRecordMap(records)) {
		let direct = records.get(decisionId);
		if (direct) return direct;
		for (let record of records.values()) {
			if (record.definition.questions.some(question => question.id === decisionId)) {
				return record;
			}
		}
		return undefined;
	}
	let list = [...records];
	let direct = list.find(record => record.id === decisionId);
	if (direct) return direct;
	return list.find(record =>
		record.definition.questions.some(question => question.id === decisionId)
	);
}

type OpenInfo = {
	definition: Question.Definition;
	revision: number;
	draftInProgress: boolean;
};

function openLookup(
	openQuestions: Questions | readonly StoredOpen[] | undefined,
): (id: string) => OpenInfo | undefined {
	if (!openQuestions) return () => undefined;
	if (!Array.isArray(openQuestions)) {
		let live = openQuestions as Questions;
		return id => {
			let entry: Open | undefined = live.open.get(id);
			if (!entry) return undefined;
			let draftInProgress = false;
			try {
				let drafts = Question.read(entry.model, entry.definition);
				draftInProgress = !isCardDraftUntouched(entry.definition, drafts);
			} catch {
				draftInProgress = false;
			}
			return {
				definition: entry.definition,
				revision: entry.revision,
				draftInProgress,
			};
		};
	}
	let byId = new Map((openQuestions as readonly StoredOpen[]).map(entry => [entry.id, entry]));
	return id => {
		let stored = byId.get(id);
		if (!stored) return undefined;
		let definition = Question.identified(stored.definition);
		let draftInProgress = false;
		try {
			let model = Question.restore(stored.model, definition);
			Question.upgrade(model, definition);
			let drafts = Question.read(model, definition);
			draftInProgress = !isCardDraftUntouched(definition, drafts);
		} catch {
			draftInProgress = false;
		}
		return {
			definition,
			revision: stored.revision,
			draftInProgress,
		};
	};
}

function historyAnswers(
	definition: Question.Definition,
	entry: DecisionEntry,
): Record<string, string> {
	let out: Record<string, string> = entry.answers ? { ...entry.answers } : {};
	let chosen = new Set(entry.choices);
	for (let question of definition.questions) {
		if (Object.hasOwn(out, question.id)) continue;
		let labels = question.options
			.filter(option => chosen.has(option.id))
			.map(option => option.label);
		if (labels.length > 0) out[question.id] = labels.join(", ");
	}
	return out;
}

function isPaused(
	record: DecisionRecord,
	conversationPlan: ConversationPlan.State | undefined,
): boolean {
	if (!isOpenStatus(record.status) || !record.threadId || !conversationPlan) return false;
	let thread = conversationPlan.threads.find(item => item.id === record.threadId);
	return !!thread && !!activeSettleDeferral(thread, conversationPlan.events);
}

function snapshotRecord(
	record: DecisionRecord,
	openInfo: OpenInfo | undefined,
	conversationPlan: ConversationPlan.State | undefined,
): DecisionSnapshot {
	let open = isOpenStatus(record.status);
	let definition = open && openInfo ? openInfo.definition : record.definition;
	let fallbackRevision = record.lastRevision ?? 0;
	let revision = open && openInfo ? openInfo.revision : fallbackRevision;
	let previous = record.history.at(-1);
	return {
		id: record.id,
		status: record.status,
		origin: record.origin,
		revision,
		paused: isPaused(record, conversationPlan),
		draftInProgress: open && openInfo ? openInfo.draftInProgress : false,
		questions: definition.questions.map(question => ({
			id: question.id,
			header: question.header,
			question: question.question,
			...(question.description !== undefined ? { description: question.description } : {}),
			multiple: question.multiple,
			...(question.response !== undefined ? { response: question.response } : {}),
			options: question.options.map(option => ({
				id: option.id,
				label: option.label,
				...(option.description !== undefined ? { description: option.description } : {}),
				...(option.preview !== undefined ? { preview: option.preview } : {}),
			})),
		})),
		...(record.status === "answered"
			? {
				settled: {
					by: record.owner ?? record.resolver ?? "",
					at: record.decidedAt ?? record.at ?? 0,
					answers: record.answers ? { ...record.answers } : {},
					optionIds: [...(record.choices ?? [])],
					...(record.why !== undefined ? { why: record.why } : {}),
				},
			}
			: {}),
		...(previous
			? {
				previous: {
					by: previous.owner,
					at: previous.at,
					answers: historyAnswers(definition, previous),
					optionIds: [...previous.choices],
					...(previous.why !== undefined ? { why: previous.why } : {}),
				},
			}
			: {}),
		historyCount: record.history.length,
	};
}

/** Build a single decision snapshot from its record and room/stored open state. */
export function readDecisionSnapshot(
	record: DecisionRecord,
	openQuestions: Questions | readonly StoredOpen[] | undefined,
	conversationPlan: ConversationPlan.State | undefined,
): DecisionSnapshot {
	return snapshotRecord(record, openLookup(openQuestions)(record.id), conversationPlan);
}

function statusMatcher(
	filter: DecisionStatusFilter | undefined,
): (status: DecisionStatus) => boolean {
	if (filter === undefined || filter === "all") return () => true;
	if (typeof filter === "string") return status => status === filter;
	let allowed = new Set(filter);
	return status => allowed.has(status);
}

/** Read and filter all decisions in a document, returning snapshots alongside total counts. */
export function readDecisions(
	records: Iterable<DecisionRecord> | ReadonlyMap<string, DecisionRecord>,
	openQuestions: Questions | readonly StoredOpen[] | undefined,
	conversationPlan: ConversationPlan.State | undefined,
	filter?: DecisionFilter,
): ReadDecisionsResult {
	let list: DecisionRecord[] = isRecordMap(records) ? [...records.values()] : [...records];
	let lookup = openLookup(openQuestions);
	let matchesStatus = statusMatcher(filter?.status);
	let decisionCounts: DecisionCounts = {
		open: 0,
		reopened: 0,
		answered: 0,
		discarded: 0,
		cancelled: 0,
		expired: 0,
		total: 0,
	};
	let decisions: DecisionSnapshot[] = [];
	for (let record of list) {
		decisionCounts[record.status]++;
		decisionCounts.total++;
		if (!matchesStatus(record.status)) continue;
		if (filter?.origin !== undefined && record.origin !== filter.origin) continue;
		decisions.push(snapshotRecord(record, lookup(record.id), conversationPlan));
	}
	return { decisions, decisionCounts };
}

/** Validate a raw decision status filter value; returns undefined when malformed. */
export function parseDecisionStatusFilter(value: unknown): DecisionStatusFilter | undefined {
	if (value === "all") return "all";
	if (typeof value === "string") {
		return DECISION_STATUSES.includes(value as DecisionStatus)
			? (value as DecisionStatus)
			: undefined;
	}
	if (!Array.isArray(value) || value.length === 0) return undefined;
	let deduped: DecisionStatus[] = [];
	let seen = new Set<string>();
	for (let item of value) {
		if (typeof item !== "string" || !DECISION_STATUSES.includes(item as DecisionStatus)) {
			return undefined;
		}
		if (!seen.has(item)) {
			seen.add(item);
			deduped.push(item as DecisionStatus);
		}
	}
	return deduped;
}

/** Validate a raw decision origin filter value; returns undefined when malformed. */
export function parseDecisionOrigin(value: unknown): DecisionOrigin | undefined {
	return typeof value === "string" && DECISION_ORIGINS.includes(value as DecisionOrigin)
		? (value as DecisionOrigin)
		: undefined;
}
