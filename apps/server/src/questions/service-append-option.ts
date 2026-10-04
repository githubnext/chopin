import { ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";
import * as Y from "yjs";

import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Store from "./store";
import { announce, emit, pending } from "./card-notifications";
import { isOpenStatus } from "./records";
import { OptionCapacityError } from "../conversation-plan/option-capacity";
import { broadcast, fail, reply } from "../wire";

import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";
import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";

/** Append a keyed shared option through the same fenced staging boundary as card actions. */
export async function appendOption(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.AddOption.Ask>,
): Promise<void> {
	let refuse = (reason: Wire.AddOption.Refusal, message: string): Wire.AddOption.Reply => ({
		kind: "question:option",
		ts: 0,
		id: msg.id,
		ok: false,
		reason,
		message,
	});
	if (Service.implementationActive(plan)) {
		return reply(
			ws,
			msg.rid,
			refuse("implementation", "An implementation is running; decisions cannot change"),
		);
	}
	let outcome: Wire.AddOption.Reply | undefined;
	let added: Wire.OptionAdded | undefined;
	await Service.exclusive(plan, async () => {
		if (Service.implementationActive(plan)) {
			outcome = refuse("implementation", "An implementation is running; decisions cannot change");
			return;
		}
		let record = plan.records.get(msg.id);
		let entry = Store.get(plan.questions, msg.id);
		if (!record || !entry || !isOpenStatus(record.status)) {
			outcome = refuse("resolved", "This question has already been decided");
			return;
		}
		if (entry.definition.questions.length !== 1) {
			outcome = refuse("invalid", "Options cannot be added to this questionnaire");
			return;
		}
		let definition = Question.decision(entry.definition);
		let applied = typeof msg.key === "string" && Object.hasOwn(record.appended ?? {}, msg.key)
			? record.appended?.[msg.key]
			: undefined;
		let existing = applied
			? definition.questions[0].options.find(option => option.id === applied)
			: undefined;
		if (existing) {
			outcome = {
				kind: "question:option",
				ts: 0,
				id: msg.id,
				ok: true,
				option: existing,
				definition,
				repeated: true,
			};
			return;
		}
		if (entry.claim) {
			outcome = refuse("resolving", "This question is being decided");
			return;
		}
		let result = Question.appendOption(definition, {
			question: msg.question,
			key: msg.key,
			label: msg.label,
			...(msg.description === undefined ? {} : { description: msg.description }),
		}, ulid());
		if (!result.ok) {
			outcome = refuse(result.reason, result.message);
			return;
		}
		let originalQuestions = plan.questions;
		if (!Store.reserveOption(originalQuestions, msg.id)) {
			outcome = refuse("resolving", "This question is being decided");
			return;
		}
		let stagedDocument: room.Document | undefined;
		try {
			let stagedQuestions: Store.Questions = {
				open: new Map(originalQuestions.open),
				closed: new Map(originalQuestions.closed),
			};
			stagedQuestions.open.set(msg.id, {
				...entry,
				claim: undefined,
				definition: result.definition,
				editors: new Set(entry.editors),
				suggested: undefined,
			});
			stagedDocument = await room.restore(
				plan.document.epoch,
				Y.encodeStateAsUpdate(plan.document.doc),
				room.project(plan.document),
				[],
			);
			stagedDocument.seq = plan.document.seq;
			let records = new Map(plan.records);
			records.set(msg.id, {
				...record,
				definition: result.definition,
				appended: { ...record.appended, [msg.key]: result.option.id },
				optionOrigins: {
					...record.optionOrigins,
					[result.option.id]: { origin: "human", by: ws.data.handle },
				},
			});
			let candidate: Plan = {
				...plan,
				document: stagedDocument,
				questions: stagedQuestions,
				records,
				pendingCardActions: pending(plan, record, {
					kind: "option-added",
					id: msg.id,
					actor: ws.data.handle,
					optionId: result.option.id,
					label: result.option.label,
					origin: "human",
				}),
			};
			let mutation = room.appendQuestionOption(stagedDocument, msg.id, msg.question, result.option);
			if (!mutation) throw new Error("question projection is missing");
			// Every open question needs room to expire, so growth stops where that room ends.
			if (
				!room.fitsOrShrinks(
					room.project(plan.document),
					room.project(stagedDocument),
					plan.questions.open.size,
				)
			) {
				outcome = refuse("invalid", "The document has no room for another option");
				return;
			}
			await Service.publishStaged(plan, server, roomId, candidate, mutation);
			outcome = {
				kind: "question:option",
				ts: 0,
				id: msg.id,
				ok: true,
				option: result.option,
				definition: result.definition,
			};
			added = {
				kind: "question:option-added",
				ts: 0,
				id: msg.id,
				question: msg.question,
				option: result.option,
				definition: result.definition,
				by: ws.data.handle,
			};
		} finally {
			Store.releaseOption(originalQuestions, msg.id);
			stagedDocument?.doc.destroy();
		}
	}).catch(err => {
		if (!(err instanceof OptionCapacityError)) {
			console.error("[questions] could not save the option:", err);
		}
		outcome = err instanceof OptionCapacityError ? refuse(err.reason, err.message) : undefined;
		added = undefined;
	});
	if (!outcome) return fail(ws, msg.rid, "could not save the option");
	reply(ws, msg.rid, outcome);
	if (!added) return;
	broadcast(server, roomId, added);
	let record = plan.records.get(msg.id);
	if (record?.origin === "conversation") {
		announce(plan, server, roomId, msg.id);
		emit(plan, {
			kind: "option-added",
			id: msg.id,
			...(record.threadId ? { threadId: record.threadId } : {}),
			actor: ws.data.handle,
			optionId: added.option.id,
			label: added.option.label,
			origin: "human",
		});
	}
}
