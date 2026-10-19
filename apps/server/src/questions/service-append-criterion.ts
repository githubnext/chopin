import { ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";
import * as Y from "yjs";

import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Store from "./store";
import { isOpenStatus } from "./records";
import { broadcast, fail, reply } from "../wire";

import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";
import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";

/**
 * Append a keyed shared criterion through the same fenced staging boundary as an option.
 *
 * The draft's shape is unchanged (its `marks` object exists and cells appear lazily), so
 * only the definition, the record and the plan projection change, together, before anyone
 * is told. `record.appended` holds the idempotency keys of options and criteria alike.
 */
export async function appendCriterion(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.AddCriterion.Ask>,
): Promise<void> {
	let refuse = (
		reason: Wire.AddCriterion.Refusal,
		message: string,
	): Wire.AddCriterion.Reply => ({
		kind: "question:criterion",
		ts: 0,
		id: msg.id,
		ok: false,
		reason,
		message,
	});
	let running = "An implementation is running; decisions cannot change";
	if (Service.implementationActive(plan)) {
		return reply(ws, msg.rid, refuse("implementation", running));
	}
	let outcome: Wire.AddCriterion.Reply | undefined;
	let added: Wire.CriterionAdded | undefined;
	await Service.exclusive(plan, async () => {
		if (Service.implementationActive(plan)) {
			outcome = refuse("implementation", running);
			return;
		}
		let record = plan.records.get(msg.id);
		let entry = Store.get(plan.questions, msg.id);
		if (!record || !entry || !isOpenStatus(record.status)) {
			outcome = refuse("resolved", "This question has already been decided");
			return;
		}
		if (entry.definition.questions.length !== 1) {
			outcome = refuse("invalid", "Criteria cannot be added to this questionnaire");
			return;
		}
		let definition = Question.decision(entry.definition);
		let applied = typeof msg.key === "string" && Object.hasOwn(record.appended ?? {}, msg.key)
			? record.appended?.[msg.key]
			: undefined;
		let existing = applied
			? definition.questions[0].criteria?.find(criterion => criterion.id === applied)
			: undefined;
		if (existing) {
			outcome = {
				kind: "question:criterion",
				ts: 0,
				id: msg.id,
				ok: true,
				criterion: existing,
				definition,
				repeated: true,
			};
			return;
		}
		if (entry.claim) {
			outcome = refuse("resolving", "This question is being decided");
			return;
		}
		let result = Question.appendCriterion(definition, {
			question: msg.question,
			key: msg.key,
			label: msg.label,
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
			// Proves the draft still reads back under the new definition before anything commits.
			Question.read(entry.model, result.definition);
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
				appended: { ...record.appended, [msg.key]: result.criterion.id },
			});
			let mutation = room.appendQuestionCriterion(
				stagedDocument,
				msg.id,
				msg.question,
				result.criterion,
			);
			if (!mutation) throw new Error("question projection is missing");
			if (!room.fitsOrShrinks(room.project(plan.document), room.project(stagedDocument))) {
				outcome = refuse("invalid", "The document has no room for another criterion");
				return;
			}
			await Service.publishStaged(plan, server, roomId, {
				...plan,
				document: stagedDocument,
				questions: stagedQuestions,
				records,
			}, mutation);
			outcome = {
				kind: "question:criterion",
				ts: 0,
				id: msg.id,
				ok: true,
				criterion: result.criterion,
				definition: result.definition,
			};
			added = {
				kind: "question:criterion-added",
				ts: 0,
				id: msg.id,
				question: msg.question,
				criterion: result.criterion,
				definition: result.definition,
				by: ws.data.handle,
			};
		} finally {
			Store.releaseOption(originalQuestions, msg.id);
			stagedDocument?.doc.destroy();
		}
	}).catch(err => {
		console.error("[questions] could not save the criterion:", err);
		outcome = undefined;
		added = undefined;
	});
	if (!outcome) return fail(ws, msg.rid, "could not save the criterion");
	reply(ws, msg.rid, outcome);
	if (added) broadcast(server, roomId, added);
}
