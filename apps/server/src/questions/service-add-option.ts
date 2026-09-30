import { ulid } from "@chopin/dialect";

import * as Y from "yjs";

import { isOpenStatus } from "./records";

import * as room from "../plan/room";
import * as Store from "./store";

import { broadcast, fail, reply } from "../wire";
import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";

import { announce, emit, pending } from "./card-notifications";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export async function addOption(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.AddOption.Ask>,
): Promise<void> {
	if (Service.implementationActive(plan)) return fail(ws, msg.rid, "implementation is active");
	if (typeof msg.label !== "string") {
		return reply(ws, msg.rid, {
			kind: "question:add-option",
			ts: 0,
			id: msg.id,
			ok: false,
			reason: "invalid",
			message: "An option needs a text label",
		});
	}
	let outcome: Store.AddedOption | undefined;
	let failure: unknown;
	await Service.exclusive(plan, async () => {
		if (Service.implementationActive(plan)) {
			failure = new Error("implementation is active");
			return;
		}
		let record = plan.records.get(msg.id);
		if (!record || !isOpenStatus(record.status)) {
			outcome = {
				ok: false,
				reason: "closed",
				message: "This decision is no longer open",
			};
			return;
		}
		if (record.definition.questions.length !== 1) {
			outcome = {
				ok: false,
				reason: "closed",
				message: "Options cannot be added to this questionnaire",
			};
			return;
		}
		let originalQuestions = plan.questions;
		if (!Store.reserveOption(originalQuestions, msg.id)) {
			outcome = Store.addOption(originalQuestions, msg.id, ulid(), msg.label);
			return;
		}

		let stagedDocument: room.Document | undefined;
		try {
			let entry = Store.get(originalQuestions, msg.id)!;
			let stagedQuestions: Store.Questions = {
				open: new Map(originalQuestions.open),
				closed: new Map(originalQuestions.closed),
			};
			stagedQuestions.open.set(msg.id, {
				...entry,
				claim: undefined,
				editors: new Set(entry.editors),
			});
			outcome = Store.addOption(stagedQuestions, msg.id, ulid(), msg.label);
			if (!outcome.ok) return;
			stagedQuestions.open.get(msg.id)!.suggested = undefined;

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
				definition: outcome.definition,
				optionOrigins: {
					...record.optionOrigins,
					[outcome.option.id]: { origin: "human", by: ws.data.handle },
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
					optionId: outcome.option.id,
					label: outcome.option.label,
					origin: "human",
				}),
			};
			let mutation = room.projectOptions(
				stagedDocument,
				msg.id,
				outcome.definition.questions[0],
			);
			await Service.publishStaged(plan, server, roomId, candidate, mutation);
		} catch (err) {
			if (err instanceof room.QuestionnaireProjectionError) {
				outcome = { ok: false, reason: "closed", message: err.message };
			} else failure = err;
		} finally {
			Store.releaseOption(originalQuestions, msg.id);
			stagedDocument?.doc.destroy();
		}
	});
	if (failure || !outcome) {
		console.error("[questions] could not add an option:", failure);
		return fail(
			ws,
			msg.rid,
			failure instanceof Error && failure.message === "implementation is active"
				? failure.message
				: "could not add the option",
		);
	}
	if (!outcome.ok) {
		return reply(ws, msg.rid, { kind: "question:add-option", ts: 0, id: msg.id, ...outcome });
	}
	reply(ws, msg.rid, {
		kind: "question:add-option",
		ts: 0,
		id: msg.id,
		ok: true,
		option: outcome.option,
		revision: outcome.revision,
	});
	broadcast(server, roomId, {
		kind: "question:changed",
		ts: 0,
		id: msg.id,
		definition: outcome.definition,
		revision: outcome.revision,
	});
	announce(plan, server, roomId, msg.id);
	let record = plan.records.get(msg.id);
	emit(plan, {
		kind: "option-added",
		id: msg.id,
		...(record?.threadId ? { threadId: record.threadId } : {}),
		actor: ws.data.handle,
		optionId: outcome.option.id,
		label: outcome.option.label,
		origin: "human",
	});
}
