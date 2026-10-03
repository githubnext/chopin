import * as Y from "yjs";

import { isOpenStatus } from "./records";

import * as room from "../plan/room";
import * as Store from "./store";

import { broadcast } from "../wire";
import type { Server } from "bun";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";

import { announce } from "./card-notifications";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export async function retitle(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	id: string,
	title: string,
	locked = false,
	beforePublish?: () => void,
): Promise<{ ok: true; revision: number } | { ok: false; message: string }> {
	let body = async () => {
		if (Service.implementationActive(plan)) {
			return { ok: false as const, message: "implementation is active" };
		}
		let record = plan.records.get(id);
		let originalQuestions = plan.questions;
		let live = Store.get(originalQuestions, id);
		if (
			!record || !isOpenStatus(record.status) || !live || live.claim
			|| record.definition.questions.length !== 1
			|| record.definition.questions[0]?.id !== live.definition.questions[0]?.id
			|| !room.hasQuestionnaire(plan.document, id, record.definition.questions[0]!.id)
		) return { ok: false as const, message: "This decision is no longer open" };
		if (!Store.reserveEdit(originalQuestions, id)) {
			return { ok: false as const, message: "This decision is no longer open" };
		}
		let stagedDocument: room.Document | undefined;
		try {
			let stagedQuestions: Store.Questions = {
				open: new Map(originalQuestions.open),
				closed: new Map(originalQuestions.closed),
			};
			stagedQuestions.open.set(id, {
				...live,
				claim: undefined,
				editors: new Set(live.editors),
			});
			let result = Store.retitle(stagedQuestions, id, title);
			if (!result.ok) return { ok: false as const, message: result.message };
			if (!result.applied) return { ok: true as const, revision: result.revision };
			stagedDocument = await room.restore(
				plan.document.epoch,
				Y.encodeStateAsUpdate(plan.document.doc),
				room.project(plan.document),
				[],
			);
			stagedDocument.seq = plan.document.seq;
			let records = new Map(plan.records);
			records.set(id, { ...record, definition: result.definition });
			let question = result.definition.questions[0]!;
			let mutation = room.projectPrompt(stagedDocument, id, question.id, question.question);
			if (!mutation) throw new Error("card prompt did not change the document");
			beforePublish?.();
			await Service.publishStaged(plan, server, roomId, {
				...plan,
				document: stagedDocument,
				questions: stagedQuestions,
				records,
				threads: new Map(plan.threads),
				outlines: new Map(plan.outlines),
			}, mutation);
			broadcast(server, roomId, {
				kind: "question:changed",
				ts: 0,
				id,
				definition: result.definition,
				revision: result.revision,
			});
			announce(plan, server, roomId, id);
			return { ok: true as const, revision: result.revision };
		} finally {
			Store.releaseEdit(originalQuestions, id);
			stagedDocument?.doc.destroy();
		}
	};
	return locked ? body() : Service.exclusive(plan, body);
}
