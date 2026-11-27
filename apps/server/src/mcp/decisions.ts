/**
 * Shared input schemas, validation, canonical fingerprinting, and durable receiver-side
 * idempotency for answering decisions through MCP `answer_decision` and `orchestrate answer`.
 */

import { createHash } from "node:crypto";

import { ulid } from "@chopin/dialect";

import { DECISION_ORIGINS, DECISION_STATUSES } from "../questions/read-decisions";
import { INVOCATION_KEY_MS } from "./invoke";

import type { DecisionAnswerValue } from "../questions/service-submit";
import type {
	DecisionCounts,
	DecisionOrigin,
	DecisionSnapshot,
	DecisionStatus,
} from "../questions/read-decisions";
import type { Lease, McpInvocationScope } from "../storage/model";
import type { McpInvocationStore } from "../storage/port";

export type DecisionAnswerPayload = {
	decisionId: string;
	revision: number;
	idempotencyKey: string;
	optionIds?: string[];
	text?: string;
	answers?: { [questionId: string]: DecisionAnswerValue };
};

export type StoredAnsweredDecision = {
	status: "answered";
	decisionId: string;
	committedAt: number;
	resolver: string;
	answers: { [questionId: string]: string };
	decision: DecisionSnapshot;
};

export type AnsweredDecision = StoredAnsweredDecision & {
	replayed: boolean;
};

export type AnswerDecisionRefusal =
	| { code: "idempotency-conflict" }
	| { code: "unknown-decision" }
	| { code: "implementation-active" }
	| { code: "paused" }
	| { code: "already-settled"; status: DecisionStatus; resolver?: string }
	| { code: "state-diverged" }
	| { code: "stale"; currentRevision: number }
	| { code: "draft-in-progress"; currentRevision: number }
	| { code: "invalid-answer"; message: string }
	| { code: "document-archived" }
	| { code: "repository-forbidden" }
	| { code: "document-unavailable" };

export type AnswerDecisionOutcome =
	| { kind: "answered"; result: AnsweredDecision }
	| { kind: "refused"; refusal: AnswerDecisionRefusal };

export const DECISION_STATUS_FILTER_SCHEMA = {
	oneOf: [
		{ type: "string", const: "all" },
		{ type: "string", enum: [...DECISION_STATUSES] },
		{
			type: "array",
			minItems: 1,
			maxItems: DECISION_STATUSES.length,
			items: { type: "string", enum: [...DECISION_STATUSES] },
		},
	],
};

export const DECISION_ORIGIN_SCHEMA = {
	type: "string",
	enum: [...DECISION_ORIGINS],
};

export const DECISION_ANSWER_VALUE_SCHEMA = {
	type: "object",
	properties: {
		optionIds: {
			type: "array",
			items: { type: "string", minLength: 1 },
		},
		text: { type: "string" },
	},
	additionalProperties: false,
};

export const DECISION_SNAPSHOT_SCHEMA = {
	type: "object",
	properties: {
		id: { type: "string" },
		status: { type: "string", enum: [...DECISION_STATUSES] },
		origin: { type: "string", enum: [...DECISION_ORIGINS] },
		revision: { type: "integer", minimum: 0 },
		paused: { type: "boolean" },
		draftInProgress: { type: "boolean" },
		questions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					header: { type: "string" },
					question: { type: "string" },
					description: { type: "string" },
					multiple: { type: "boolean" },
					response: { type: "string", const: "text" },
					options: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								label: { type: "string" },
								description: { type: "string" },
								preview: { type: "string" },
							},
							required: ["id", "label"],
							additionalProperties: false,
						},
					},
				},
				required: ["id", "header", "question", "multiple", "options"],
				additionalProperties: false,
			},
		},
		settled: {
			type: "object",
			properties: {
				by: { type: "string" },
				at: { type: "integer" },
				answers: { type: "object", additionalProperties: { type: "string" } },
				optionIds: { type: "array", items: { type: "string" } },
				why: { type: "string" },
			},
			required: ["by", "at", "answers", "optionIds"],
			additionalProperties: false,
		},
		previous: {
			type: "object",
			properties: {
				by: { type: "string" },
				at: { type: "integer" },
				answers: { type: "object", additionalProperties: { type: "string" } },
				optionIds: { type: "array", items: { type: "string" } },
				why: { type: "string" },
			},
			required: ["by", "at", "answers", "optionIds"],
			additionalProperties: false,
		},
		historyCount: { type: "integer", minimum: 0 },
	},
	required: [
		"id",
		"status",
		"origin",
		"revision",
		"paused",
		"draftInProgress",
		"questions",
		"historyCount",
	],
	additionalProperties: false,
};

export const DECISION_COUNTS_SCHEMA = {
	type: "object",
	properties: {
		open: { type: "integer", minimum: 0 },
		reopened: { type: "integer", minimum: 0 },
		answered: { type: "integer", minimum: 0 },
		discarded: { type: "integer", minimum: 0 },
		cancelled: { type: "integer", minimum: 0 },
		expired: { type: "integer", minimum: 0 },
		total: { type: "integer", minimum: 0 },
	},
	required: ["open", "reopened", "answered", "discarded", "cancelled", "expired", "total"],
	additionalProperties: false,
};

const KEY_PREFIX = "answer_decision:";

/** Namespaces an idempotency key for `mcp_invocations`, staying within the 128-char column bound. */
export function answerDecisionInvocationKey(idempotencyKey: string): string {
	let raw = `${KEY_PREFIX}${idempotencyKey}`;
	if (Array.from(raw).length <= 128 && !idempotencyKey.startsWith("sha256:")) return raw;
	return `${KEY_PREFIX}sha256:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

function canonicalAnswerValue(value: DecisionAnswerValue) {
	return {
		optionIds: value.optionIds ?? null,
		text: value.text ?? null,
	};
}

/** Canonical SHA-256 fingerprint over `{ decisionId, revision, optionIds, text, answers }`. */
export function answerDecisionFingerprint(
	input: Pick<DecisionAnswerPayload, "decisionId" | "revision" | "optionIds" | "text" | "answers">,
): string {
	let answers = input.answers
		? Object.fromEntries(
			Object.keys(input.answers).sort().map(
				key => [key, canonicalAnswerValue(input.answers![key]!)],
			),
		)
		: null;
	return createHash("sha256")
		.update(JSON.stringify({
			decisionId: input.decisionId,
			revision: input.revision,
			optionIds: input.optionIds ?? null,
			text: input.text ?? null,
			answers,
		}))
		.digest("hex");
}

function parseAnswerValue(value: unknown): DecisionAnswerValue | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let record = value as Record<string, unknown>;
	let keys = Object.keys(record);
	if (keys.some(key => key !== "optionIds" && key !== "text")) return undefined;
	if (
		Object.hasOwn(record, "optionIds")
		&& (!Array.isArray(record.optionIds)
			|| record.optionIds.some(item => typeof item !== "string" || !item.trim()))
	) return undefined;
	if (Object.hasOwn(record, "text") && typeof record.text !== "string") return undefined;
	return {
		...(Object.hasOwn(record, "optionIds") ? { optionIds: record.optionIds as string[] } : {}),
		...(Object.hasOwn(record, "text") ? { text: record.text as string } : {}),
	};
}

/** Validate the decision-answer fields shared by `answer_decision` and `orchestrate answer`. */
export function parseDecisionAnswerPayload(
	args: Record<string, unknown>,
): { ok: true; value: DecisionAnswerPayload } | { ok: false; message: string } {
	if (typeof args.decisionId !== "string" || !args.decisionId.trim()) {
		return { ok: false, message: "decisionId must be a non-empty card or question ID" };
	}
	if (!Number.isSafeInteger(args.revision) || (args.revision as number) < 0) {
		return { ok: false, message: "revision must be a non-negative integer" };
	}
	if (
		typeof args.idempotencyKey !== "string"
		|| !args.idempotencyKey.trim()
		|| Array.from(args.idempotencyKey).length > 128
	) {
		return {
			ok: false,
			message: "idempotencyKey must be a non-empty string of at most 128 characters",
		};
	}
	let optionIds: string[] | undefined;
	if (Object.hasOwn(args, "optionIds")) {
		if (
			!Array.isArray(args.optionIds)
			|| args.optionIds.some(item => typeof item !== "string" || !item.trim())
		) {
			return { ok: false, message: "optionIds must be an array of non-empty option IDs" };
		}
		optionIds = args.optionIds as string[];
	}
	let text: string | undefined;
	if (Object.hasOwn(args, "text")) {
		if (typeof args.text !== "string") {
			return { ok: false, message: "text must be a string" };
		}
		text = args.text;
	}
	let answers: { [questionId: string]: DecisionAnswerValue } | undefined;
	if (Object.hasOwn(args, "answers")) {
		if (!args.answers || typeof args.answers !== "object" || Array.isArray(args.answers)) {
			return { ok: false, message: "answers must be an object keyed by question ID" };
		}
		let parsed: { [questionId: string]: DecisionAnswerValue } = {};
		for (let [questionId, rawValue] of Object.entries(args.answers as Record<string, unknown>)) {
			if (!questionId.trim()) {
				return { ok: false, message: "answers keys must be non-empty question IDs" };
			}
			let item = parseAnswerValue(rawValue);
			if (!item) {
				return {
					ok: false,
					message: `answers.${questionId} must be an object with optional optionIds and/or text`,
				};
			}
			parsed[questionId] = item;
		}
		answers = parsed;
	}
	return {
		ok: true,
		value: {
			decisionId: args.decisionId,
			revision: args.revision as number,
			idempotencyKey: args.idempotencyKey,
			...(optionIds !== undefined ? { optionIds } : {}),
			...(text !== undefined ? { text } : {}),
			...(answers !== undefined ? { answers } : {}),
		},
	};
}

/** Concise human-readable lines for `read_document`'s `Decisions:` text section. */
export function decisionNoteLines(
	decisions: readonly DecisionSnapshot[],
	counts: DecisionCounts,
): string[] {
	let lines = [
		`counts: open=${counts.open}, reopened=${counts.reopened}, answered=${counts.answered}, `
		+ `discarded=${counts.discarded}, cancelled=${counts.cancelled}, expired=${counts.expired} `
		+ `(total=${counts.total})`,
	];
	for (let decision of decisions) {
		let flags = [
			decision.status,
			...(decision.paused ? ["paused"] : []),
			...(decision.draftInProgress ? ["draft-in-progress"] : []),
		].join(", ");
		let prompts = decision.questions.map(question => {
			let options = question.options.length > 0
				? ` [${question.options.map(option => `${option.id}:${option.label}`).join(", ")}]`
				: question.response === "text"
				? " [text]"
				: "";
			return `${question.id} ${JSON.stringify(question.question)}${options}`;
		}).join("; ");
		let settled = decision.settled
			? ` -> @${decision.settled.by}: ${Object.values(decision.settled.answers).join("; ")}`
			: "";
		lines.push(
			`- [${flags}] ${decision.id} (rev ${decision.revision}, ${decision.origin}): ${prompts}${settled}`,
		);
	}
	return lines;
}

/**
 * Durable receiver-side idempotency for `answer_decision`, serialized per `(userId, channelId, key)`
 * in memory and persisted in `storage.mcpInvocations`.
 */
export class IdempotentDecisionAnswers {
	#running = new Map<string, Promise<unknown>>();
	#unrecorded = new Map<string, { entryId: string; result: StoredAnsweredDecision }>();

	constructor(
		private store: McpInvocationStore,
		private lease: () => Lease,
		private clock: () => Date,
	) {}

	run(
		scope: McpInvocationScope,
		fingerprint: string,
		execute: () => Promise<AnswerDecisionOutcome>,
	): Promise<AnswerDecisionOutcome> {
		let namespaced: McpInvocationScope = {
			userId: scope.userId,
			channelId: scope.channelId,
			key: answerDecisionInvocationKey(scope.key),
		};
		let key = JSON.stringify([namespaced.userId, namespaced.channelId, namespaced.key]);
		let previous = this.#running.get(key) ?? Promise.resolve();
		let operation = previous.then(() => this.#once(key, namespaced, fingerprint, execute));
		let settled = operation.then(() => {}, () => {});
		this.#running.set(key, settled);
		void settled.then(() => {
			if (this.#running.get(key) === settled) this.#running.delete(key);
		});
		return operation;
	}

	async #once(
		key: string,
		scope: McpInvocationScope,
		fingerprint: string,
		execute: () => Promise<AnswerDecisionOutcome>,
	): Promise<AnswerDecisionOutcome> {
		let lease = this.lease();
		let claim = async () => {
			let now = this.clock();
			return this.store.claim(lease, {
				...scope,
				fingerprint,
				entryId: ulid(),
				result: {},
				createdAt: now,
				expiresAt: new Date(now.getTime() + INVOCATION_KEY_MS),
			});
		};
		let { record, claimed } = await claim();
		if (record.invokedAt) {
			if (record.fingerprint !== fingerprint) {
				return { kind: "refused", refusal: { code: "idempotency-conflict" } };
			}
			let stored = record.result as StoredAnsweredDecision;
			return { kind: "answered", result: { ...stored, replayed: true } };
		}
		let unrecorded = this.#unrecorded.get(key);
		if (record.fingerprint === fingerprint && unrecorded?.entryId === record.entryId) {
			await this.store.complete(lease, record, this.clock(), unrecorded.result);
			this.#unrecorded.delete(key);
			return { kind: "answered", result: { ...unrecorded.result, replayed: true } };
		}
		if (!claimed) {
			// An incomplete row left by a crashed prior process: release and re-claim cleanly.
			await this.store.release(lease, record);
			let reclaimed = await claim();
			record = reclaimed.record;
			if (record.invokedAt) {
				if (record.fingerprint !== fingerprint) {
					return { kind: "refused", refusal: { code: "idempotency-conflict" } };
				}
				let stored = record.result as StoredAnsweredDecision;
				return { kind: "answered", result: { ...stored, replayed: true } };
			}
			if (!reclaimed.claimed) {
				return { kind: "refused", refusal: { code: "idempotency-conflict" } };
			}
		}

		let outcome: AnswerDecisionOutcome;
		try {
			outcome = await execute();
		} catch (err) {
			await this.store.release(lease, record).catch(releaseErr => {
				console.error("[mcp] could not free an answer_decision key after error:", releaseErr);
			});
			throw err;
		}
		if (outcome.kind === "refused") {
			await this.store.release(lease, record).catch(releaseErr => {
				console.error("[mcp] could not free an answer_decision key after refusal:", releaseErr);
			});
			return outcome;
		}
		let { replayed: _replayed, ...stored } = outcome.result;
		try {
			await this.store.complete(lease, record, this.clock(), stored);
		} catch (err) {
			this.#unrecorded.set(key, { entryId: record.entryId, result: stored });
			throw err;
		}
		if (this.#unrecorded.get(key)?.entryId === record.entryId) this.#unrecorded.delete(key);
		return { kind: "answered", result: { ...stored, replayed: false } };
	}
}

export type DecisionReadRequest = {
	includeDecisions?: boolean;
	decisionStatus?: "all" | DecisionStatus | DecisionStatus[];
	decisionOrigin?: DecisionOrigin;
};
