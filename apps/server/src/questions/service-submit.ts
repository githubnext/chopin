import * as Question from "@chopin/question";
import * as Y from "yjs";

import { activeSettleDeferral } from "../conversation-plan/preference";
import { ConversationCapacityError } from "../conversation-plan/events";

import * as Anchors from "./anchors";
import { isOpenStatus } from "./records";

import * as room from "../plan/room";
import * as Store from "./store";

import { broadcast, fail, reply } from "../wire";
import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";

import type { Record } from "./records";
import { appendProseEffect, settleIntent } from "../conversation-plan/prose-job";
import { appendFollowupEffect } from "./decision-followup";
import { plannerToActOn } from "./answer-turns";
import { decisionGeneration } from "./card-actions";
import {
	isCardDraftUntouched,
	readDecisionSnapshot,
	resolveDecisionRecord,
} from "./read-decisions";
import type { DecisionSnapshot } from "./read-decisions";

import type { CardEvent } from "./card-event";
import { announce, emit, pending } from "./card-notifications";
import { decide } from "./service-definition";

export type DecisionAnswerValue = {
	optionIds?: string[];
	text?: string;
};

export type AnswerDecisionInput = {
	/** Decision card ID or any question ID within the card. */
	decisionId: string;
	revision: number;
	resolver: string;
	optionIds?: string[];
	text?: string;
	answers?: { [questionId: string]: DecisionAnswerValue };
};

export type AnswerDecisionResult =
	| {
		ok: true;
		decisionId: string;
		committedAt: number;
		resolver: string;
		answers: { [questionId: string]: string };
		decision: DecisionSnapshot;
	}
	| { ok: false; code: "unknown-decision" }
	| { ok: false; code: "implementation-active" }
	| { ok: false; code: "paused" }
	| { ok: false; code: "already-settled"; status: Record["status"]; resolver?: string }
	| { ok: false; code: "state-diverged" }
	| { ok: false; code: "stale"; currentRevision: number }
	| { ok: false; code: "draft-in-progress"; currentRevision: number }
	| { ok: false; code: "invalid-answer"; message: string };

function isRecordPaused(plan: Plan, id: string): boolean {
	let record = plan.records.get(id);
	let thread = plan.conversationPlan.threads.find(item => item.id === record?.threadId);
	return !!thread && !!activeSettleDeferral(thread, plan.conversationPlan.events);
}

function buildExplicitAnswers(
	definition: Question.Definition,
	input: Pick<AnswerDecisionInput, "optionIds" | "text" | "answers">,
): { ok: true; answers: Question.Answer[] } | { ok: false; message: string } {
	let hasMap = input.answers !== undefined;
	let hasFlat = input.optionIds !== undefined || input.text !== undefined;
	if (hasMap && hasFlat) {
		return {
			ok: false,
			message: "Provide either `answers` or top-level `optionIds`/`text`, not both.",
		};
	}
	if (!hasMap && !hasFlat) {
		return {
			ok: false,
			message: "An answer is required: provide `optionIds`, `text`, or `answers`.",
		};
	}
	let byQuestion: { [questionId: string]: DecisionAnswerValue };
	if (hasMap) {
		let knownQuestions = new Set(definition.questions.map(question => question.id));
		for (let questionId of Object.keys(input.answers!)) {
			if (!knownQuestions.has(questionId)) {
				return { ok: false, message: `Unknown question id: ${questionId}` };
			}
		}
		byQuestion = input.answers!;
	} else {
		if (definition.questions.length !== 1) {
			return {
				ok: false,
				message: "This decision has multiple questions; provide `answers` keyed by question ID.",
			};
		}
		byQuestion = {
			[definition.questions[0]!.id]: {
				...(input.optionIds !== undefined ? { optionIds: input.optionIds } : {}),
				...(input.text !== undefined ? { text: input.text } : {}),
			},
		};
	}

	let drafts: Question.Drafts = {};
	for (let question of definition.questions) {
		let supplied = byQuestion[question.id];
		if (!supplied) return { ok: false, message: `${question.header} requires an answer` };
		if (supplied.optionIds !== undefined && supplied.text !== undefined) {
			return {
				ok: false,
				message: `${question.header} accepts either optionIds or text, not both`,
			};
		}
		if (supplied.optionIds === undefined && supplied.text === undefined) {
			return { ok: false, message: `${question.header} requires an answer` };
		}
		if (supplied.optionIds !== undefined) {
			if (question.response === "text") {
				return { ok: false, message: `${question.header} requires a written answer` };
			}
			if (supplied.optionIds.length === 0) {
				return { ok: false, message: `${question.header} requires an answer` };
			}
			if (new Set(supplied.optionIds).size !== supplied.optionIds.length) {
				return { ok: false, message: `${question.header} has duplicate optionIds` };
			}
			if (!question.multiple && supplied.optionIds.length > 1) {
				return { ok: false, message: `${question.header} accepts only one answer` };
			}
			let knownOptions = new Set(question.options.map(option => option.id));
			let unknownOption = supplied.optionIds.find(optionId => !knownOptions.has(optionId));
			if (unknownOption !== undefined) {
				return { ok: false, message: `${question.header} has unknown option id: ${unknownOption}` };
			}
			let selected = new Set(supplied.optionIds);
			drafts[question.id] = {
				mode: "choices",
				choice: question.multiple ? null : (supplied.optionIds[0] ?? null),
				options: Object.fromEntries(
					question.options.map(option => [option.id, selected.has(option.id)]),
				),
				custom: "",
			};
		} else {
			let written = supplied.text!;
			if (!question.verbatim && written.length > Question.limits.MAX_CUSTOM) {
				return {
					ok: false,
					message: `${question.header} exceeds ${Question.limits.MAX_CUSTOM} characters`,
				};
			}
			drafts[question.id] = {
				mode: "custom",
				choice: null,
				options: Object.fromEntries(question.options.map(option => [option.id, false])),
				custom: written,
			};
		}
	}

	let outcome = Question.derive(definition, drafts);
	if (!outcome.ok) return { ok: false, message: outcome.message };
	return { ok: true, answers: outcome.answers };
}

type SettleAttempt =
	| {
		ok: true;
		finish: () => Store.Ended;
		optionIds: string[];
		committedAt: number;
	}
	| {
		ok: false;
		invalid?: string;
		failure?: unknown;
		reason?:
			| { code: "unknown-decision" }
			| { code: "implementation-active" }
			| { code: "paused" }
			| { code: "already-settled"; status: Record["status"]; resolver?: string }
			| { code: "state-diverged" }
			| { code: "stale"; currentRevision: number };
	};

async function settleClaimed(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	cardId: string,
	resolver: string,
	claim: Store.Claim,
	claimedAnswers: Question.Answer[],
	onCommitted?: (intent: NonNullable<ReturnType<typeof settleIntent>>) => void,
): Promise<SettleAttempt> {
	let invalid: string | undefined;
	let failure: unknown;
	let reason: Extract<SettleAttempt, { ok: false }>["reason"];
	let finish: (() => Store.Ended) | undefined;
	let optionIds: string[] = [];
	let committedAt = 0;
	try {
		await Service.exclusive(plan, async () => {
			if (Service.implementationActive(plan)) {
				reason = { code: "implementation-active" };
				throw new Error("implementation is active");
			}
			if (isRecordPaused(plan, cardId)) {
				reason = { code: "paused" };
				invalid = "This decision is paused pending verification";
				return;
			}
			let record = plan.records.get(cardId);
			if (!record) {
				reason = { code: "unknown-decision" };
				invalid = "This decision is no longer open";
				return;
			}
			if (!isOpenStatus(record.status)) {
				let settledBy = record.resolver ?? record.owner;
				reason = {
					code: "already-settled",
					status: record.status,
					...(settledBy !== undefined ? { resolver: settledBy } : {}),
				};
				invalid = "This decision is no longer open";
				return;
			}
			let currentEntry = plan.questions.open.get(cardId);
			if (!currentEntry) {
				reason = { code: "state-diverged" };
				invalid = "This decision is no longer open";
				return;
			}
			if (currentEntry !== claim.entry) {
				reason = { code: "stale", currentRevision: currentEntry.revision };
				invalid = "This decision is no longer open";
				return;
			}
			let stagedDocument: room.Document | undefined;
			try {
				stagedDocument = await room.restore(
					plan.document.epoch,
					Y.encodeStateAsUpdate(plan.document.doc),
					room.project(plan.document),
					[],
				);
				stagedDocument.seq = plan.document.seq;
				let answers = decide({ status: "answered", answers: claimedAnswers }, record.definition);
				let chosen: { [question: string]: string[] } = {};
				record.definition.questions.forEach((question, index) => {
					let ids = claimedAnswers[index]?.optionIds;
					if (ids?.length) chosen[question.id] = ids;
				});
				optionIds = Object.values(chosen).flat();
				let at = Math.floor(Date.now() / 1_000);
				committedAt = at;
				let settled = { by: resolver, at: new Date(at * 1_000).toISOString() };
				// The saved answer keeps a snapshot of the matrix: the draft is replaced on reopen.
				let marks = claimedAnswers[0]?.marks;
				let mutation = room.projectAnswer(stagedDocument, cardId, answers, settled, chosen, marks);
				// A long answer can push the document past its size limit, after which the
				// Planner can no longer edit it; check the staged copy so a refusal changes nothing.
				try {
					let source = room.project(stagedDocument);
					room.validate(source);
				} catch (err) {
					invalid = err instanceof Error ? err.message : "could not record the answer";
					return;
				}
				let records = new Map(plan.records);
				let answered: Record = {
					...record,
					status: "answered",
					answers,
					resolver,
					at,
					owner: resolver,
					decidedAt: at,
					choices: optionIds,
					...(marks ? { marks } : {}),
					editors: [...new Set([...record.editors, ...claim.entry.editors])],
					anchors: Anchors.answer(record),
					lastRevision: claim.entry.revision,
				};
				records.set(cardId, answered);
				let intent = settleIntent(answered);
				let effects = appendFollowupEffect(
					appendProseEffect(
						plan.conversationPlanPendingEffects,
						plan.conversationPlanEffects,
						answered,
					),
					plan.conversationPlanEffects,
					answered,
				);
				let stagedQuestions: Store.Questions = {
					open: new Map(plan.questions.open),
					closed: new Map(plan.questions.closed),
				};
				let complete = Store.stage(stagedQuestions, claim);
				await Service.publishStaged(plan, server, roomId, {
					...plan,
					document: stagedDocument,
					questions: stagedQuestions,
					records,
					conversationPlanPendingEffects: effects,
					pendingCardActions: pending(
						plan,
						record,
						{
							kind: "decided",
							id: cardId,
							actor: resolver,
							optionIds,
						},
						at,
						claimedAnswers.map(Question.summarize).join("; "),
					),
				}, mutation);
				finish = complete;
				if (intent) {
					try {
						onCommitted?.(intent);
					} catch (error) {
						console.error("[questions] could not capture saved decision claimant:", error);
					}
				}
			} catch (err) {
				if (err instanceof room.QuestionnaireProjectionError) invalid = err.message;
				else failure = err;
			} finally {
				stagedDocument?.doc.destroy();
			}
		});
	} catch (err) {
		failure = err;
	}
	if (!finish) return { ok: false, invalid, failure, reason };
	return { ok: true, finish, optionIds, committedAt };
}

function publishDecisionNotifications(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	cardId: string,
	resolver: string,
	answers: Question.Answer[],
	optionIds: string[],
	entry: Store.Claim["entry"],
	onPlannerAnswer?: (id: string, generation: number) => void,
	beforeBroadcast?: () => void,
): void {
	let record = plan.records.get(cardId)!;
	let event: CardEvent = {
		kind: "decided",
		id: cardId,
		...(record.threadId ? { threadId: record.threadId } : {}),
		actor: resolver,
		optionIds,
	};
	let notifications = [
		...(beforeBroadcast ? [beforeBroadcast] : []),
		() =>
			broadcast(server, roomId, {
				kind: "question:resolved",
				ts: 0,
				id: cardId,
				status: "answered",
				resolver,
				answers,
			}),
		() => announce(plan, server, roomId, cardId),
		// An answer can put a review on the Planner's list; readers learn its prose is owed.
		() => Service.anchors(plan, server, roomId),
		() => emit(plan, event),
		() => {
			if (plannerToActOn(record, entry)) {
				onPlannerAnswer?.(cardId, decisionGeneration(record));
			}
		},
	];
	for (let notify of notifications) {
		try {
			notify();
		} catch (error) {
			console.error("[questions] could not announce a saved decision:", error);
		}
	}
}

/**
 * Answer an open or reopened decision explicitly (by card ID or any question ID) using the exact
 * same atomic staging, projection, persistence, broadcast, and Planner handoff core as browser
 * WebSocket submission.
 */
export async function answerDecision(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	input: AnswerDecisionInput,
	callbacks?: {
		onCommitted?: (intent: NonNullable<ReturnType<typeof settleIntent>>) => void;
		onPlannerAnswer?: (id: string, generation: number) => void;
	},
): Promise<AnswerDecisionResult> {
	let record = resolveDecisionRecord(plan.records, input.decisionId);
	if (!record) return { ok: false, code: "unknown-decision" };
	let cardId = record.id;
	if (Service.implementationActive(plan)) return { ok: false, code: "implementation-active" };
	if (isRecordPaused(plan, cardId)) return { ok: false, code: "paused" };
	if (!isOpenStatus(record.status)) {
		let settledBy = record.resolver ?? record.owner;
		return {
			ok: false,
			code: "already-settled",
			status: record.status,
			...(settledBy !== undefined ? { resolver: settledBy } : {}),
		};
	}
	let entry = plan.questions.open.get(cardId);
	if (!entry) return { ok: false, code: "state-diverged" };
	if (entry.claim || entry.revision !== input.revision) {
		return { ok: false, code: "stale", currentRevision: entry.revision };
	}
	let existingDrafts: Question.Drafts;
	try {
		existingDrafts = Question.read(entry.model, entry.definition);
	} catch (err) {
		return {
			ok: false,
			code: "invalid-answer",
			message: err instanceof Error ? err.message : "invalid draft",
		};
	}
	if (!isCardDraftUntouched(entry.definition, existingDrafts)) {
		return { ok: false, code: "draft-in-progress", currentRevision: entry.revision };
	}
	let derived = buildExplicitAnswers(entry.definition, input);
	if (!derived.ok) return { ok: false, code: "invalid-answer", message: derived.message };

	entry.claim = "submit";
	let claim: Store.Claim = {
		id: cardId,
		entry,
		result: { status: "answered", answers: derived.answers, resolver: input.resolver },
	};
	let settled = await settleClaimed(
		plan,
		server,
		roomId,
		cardId,
		input.resolver,
		claim,
		derived.answers,
		callbacks?.onCommitted,
	);
	if (!settled.ok) {
		Store.rollback(plan.questions, claim);
		if (settled.reason) return { ok: false, ...settled.reason };
		if (settled.invalid) return { ok: false, code: "invalid-answer", message: settled.invalid };
		throw settled.failure ?? new Error("could not save the decision");
	}
	settled.finish();
	publishDecisionNotifications(
		plan,
		server,
		roomId,
		cardId,
		input.resolver,
		derived.answers,
		settled.optionIds,
		entry,
		callbacks?.onPlannerAnswer,
	);
	let saved = plan.records.get(cardId)!;
	return {
		ok: true,
		decisionId: cardId,
		committedAt: settled.committedAt,
		resolver: input.resolver,
		answers: saved.answers ? { ...saved.answers } : {},
		decision: readDecisionSnapshot(saved, plan.questions, plan.conversationPlan),
	};
}

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export async function submit(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Submit.Ask>,
	onCommitted?: (intent: NonNullable<ReturnType<typeof settleIntent>>) => void,
	/** A saved answer the Planner asked for without waiting, which it should now act on. */
	onPlannerAnswer?: (id: string, generation: number) => void,
): Promise<void> {
	if (Service.implementationActive(plan)) return fail(ws, msg.rid, "implementation is active");
	if (isRecordPaused(plan, msg.id)) {
		return reply(ws, msg.rid, {
			kind: "question:submit",
			ts: 0,
			id: msg.id,
			ok: false,
			reason: "invalid",
			message: "This decision is paused pending verification",
		});
	}
	let claimed = Store.claimSubmit(
		plan.questions,
		msg.id,
		msg.revision,
		ws.data.handle,
		msg.suggestedOptionId,
	);
	if (!claimed.ok) {
		return reply(ws, msg.rid, { kind: "question:submit", ts: 0, id: msg.id, ...claimed });
	}
	let settled = await settleClaimed(
		plan,
		server,
		roomId,
		msg.id,
		ws.data.handle,
		claimed.claim,
		claimed.answers,
		onCommitted,
	);
	if (!settled.ok) {
		Store.rollback(plan.questions, claimed.claim);
		if (settled.invalid) {
			return reply(ws, msg.rid, {
				kind: "question:submit",
				ts: 0,
				id: msg.id,
				ok: false,
				reason: "invalid",
				message: settled.invalid,
			});
		}
		return fail(
			ws,
			msg.rid,
			settled.failure instanceof ConversationCapacityError
				|| settled.failure instanceof Error
					&& settled.failure.message === "implementation is active"
				? settled.failure.message
				: "could not save the decision",
		);
	}
	settled.finish();
	publishDecisionNotifications(
		plan,
		server,
		roomId,
		msg.id,
		ws.data.handle,
		claimed.answers,
		settled.optionIds,
		claimed.claim.entry,
		onPlannerAnswer,
		() =>
			reply(ws, msg.rid, {
				kind: "question:submit",
				ts: 0,
				id: msg.id,
				ok: true,
				answers: claimed.answers,
				resolver: ws.data.handle,
			}),
	);
}
