import * as Question from "@chopin/question";
import * as Y from "yjs";

import { activeSettleDeferral } from "../conversation-plan/preference";
import { ConversationCapacityError } from "../conversation-plan/events";

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
import { appendProseEffect, proseIntent } from "../conversation-plan/prose-job";

import type { CardEvent } from "./card-event";
import { announce, emit, pending } from "./card-notifications";
import { decide } from "./service-definition";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export async function submit(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Submit.Ask>,
	onCommitted?: (intent: NonNullable<ReturnType<typeof proseIntent>>) => void,
): Promise<void> {
	if (Service.implementationActive(plan)) return fail(ws, msg.rid, "implementation is active");
	let paused = () => {
		let record = plan.records.get(msg.id);
		let thread = plan.conversationPlan.threads.find(item => item.id === record?.threadId);
		return !!thread && !!activeSettleDeferral(thread, plan.conversationPlan.events);
	};
	if (paused()) {
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
	let invalid: string | undefined;
	let failure: unknown;
	let finish: (() => Store.Ended) | undefined;
	let optionIds: string[] = [];
	try {
		await Service.exclusive(plan, async () => {
			if (Service.implementationActive(plan)) throw new Error("implementation is active");
			if (paused()) {
				invalid = "This decision is paused pending verification";
				return;
			}
			let record = plan.records.get(msg.id);
			if (!record || !isOpenStatus(record.status)) {
				invalid = "This decision is no longer open";
				return;
			}
			if (plan.questions.open.get(msg.id) !== claimed.claim.entry) {
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
				let answers = decide({ status: "answered", answers: claimed.answers }, record.definition);
				let chosen: { [question: string]: string[] } = {};
				record.definition.questions.forEach((question, index) => {
					let ids = claimed.answers[index]?.optionIds;
					if (ids?.length) chosen[question.id] = ids;
				});
				optionIds = Object.values(chosen).flat();
				let at = Math.floor(Date.now() / 1_000);
				let settled = { by: ws.data.handle, at: new Date(at * 1_000).toISOString() };
				let mutation = room.projectAnswer(stagedDocument, msg.id, answers, settled, chosen);
				let records = new Map(plan.records);
				let answered: Record = {
					...record,
					status: "answered",
					answers,
					resolver: ws.data.handle,
					at,
					owner: ws.data.handle,
					decidedAt: at,
					choices: optionIds,
					editors: [...new Set([...record.editors, ...claimed.claim.entry.editors])],
				};
				records.set(msg.id, answered);
				let intent = proseIntent(answered);
				let effects = appendProseEffect(
					plan.conversationPlanPendingEffects,
					plan.conversationPlanEffects,
					answered,
				);
				let stagedQuestions: Store.Questions = {
					open: new Map(plan.questions.open),
					closed: new Map(plan.questions.closed),
				};
				let complete = Store.stage(stagedQuestions, claimed.claim);
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
							id: msg.id,
							actor: ws.data.handle,
							optionIds,
						},
						at,
						claimed.answers.map(Question.summarize).join("; "),
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
	if (!finish) {
		Store.rollback(plan.questions, claimed.claim);
		if (invalid) {
			return reply(ws, msg.rid, {
				kind: "question:submit",
				ts: 0,
				id: msg.id,
				ok: false,
				reason: "invalid",
				message: invalid,
			});
		}
		return fail(
			ws,
			msg.rid,
			failure instanceof ConversationCapacityError
				|| failure instanceof Error && failure.message === "implementation is active"
				? failure.message
				: "could not save the decision",
		);
	}
	finish();
	let record = plan.records.get(msg.id)!;
	let event: CardEvent = {
		kind: "decided",
		id: msg.id,
		...(record.threadId ? { threadId: record.threadId } : {}),
		actor: ws.data.handle,
		optionIds,
	};
	for (
		let notify of [
			() =>
				reply(ws, msg.rid, {
					kind: "question:submit",
					ts: 0,
					id: msg.id,
					ok: true,
					answers: claimed.answers,
					resolver: ws.data.handle,
				}),
			() =>
				broadcast(server, roomId, {
					kind: "question:resolved",
					ts: 0,
					id: msg.id,
					status: "answered",
					resolver: ws.data.handle,
					answers: claimed.answers,
				}),
			() => announce(plan, server, roomId, msg.id),
			() => emit(plan, event),
		]
	) {
		try {
			notify();
		} catch (error) {
			console.error("[questions] could not announce a saved decision:", error);
		}
	}
}
