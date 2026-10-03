import { ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";
import * as Y from "yjs";

import { appendCardAction, captureCardAction } from "./card-actions";

import { isOpenStatus } from "./records";

import * as room from "../plan/room";
import * as Store from "./store";

import { broadcast } from "../wire";
import type { Server } from "bun";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";

import { announce, emit } from "./card-notifications";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export async function revisePlannerCard(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	id: string,
	input: { title?: string; addOptions: Array<{ label: string; rationale: string }> },
	locked = false,
	beforePublish?: () => void,
): Promise<{ title: string; added: string[] }> {
	let body = async () => {
		if (Service.implementationActive(plan)) throw new Error("implementation is active");
		let record = plan.records.get(id);
		let originalQuestions = plan.questions;
		let live = Store.get(originalQuestions, id);
		if (
			!record || !isOpenStatus(record.status) || !live || live.claim
			|| record.definition.questions.length !== 1
			|| record.definition.questions[0]?.id !== live.definition.questions[0]?.id
			|| !room.hasQuestionnaire(plan.document, id, record.definition.questions[0]!.id)
		) throw new Error("that decision is no longer open in this document");
		if (!Store.reserveEdit(originalQuestions, id)) {
			throw new Error("that decision is no longer open in this document");
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
			let title = record.definition.questions[0]!.question;
			if (input.title !== undefined) {
				let retitled = Store.retitle(stagedQuestions, id, input.title);
				if (!retitled.ok) throw new Error(retitled.message);
				title = retitled.definition.questions[0]!.question;
			}
			let added: Array<{ id: string; label: string }> = [];
			let origins = { ...record.optionOrigins };
			let actions = plan.pendingCardActions;
			let at = Math.floor(Date.now() / 1_000);
			for (let option of input.addOptions) {
				let result = Store.addOption(stagedQuestions, id, ulid(), option.label);
				if (!result.ok) throw new Error(`option addition was refused: ${result.reason}`);
				added.push({ id: result.option.id, label: result.option.label });
				origins[result.option.id] = { origin: "planner", rationale: option.rationale };
				actions = appendCardAction(
					actions,
					captureCardAction(record, {
						kind: "option-added",
						id,
						actor: "chopin",
						optionId: result.option.id,
						label: result.option.label,
						origin: "planner",
					}, at),
				);
			}
			let final = Store.get(stagedQuestions, id)!;
			if (title === record.definition.questions[0]!.question && added.length === 0) {
				return { title, added: [] };
			}
			let vector = Y.encodeStateVector(plan.document.doc);
			stagedDocument = await room.restore(
				plan.document.epoch,
				Y.encodeStateAsUpdate(plan.document.doc),
				room.project(plan.document),
				[],
			);
			stagedDocument.seq = plan.document.seq;
			let question = final.definition.questions[0]!;
			let definition = Question.decision(final.definition);
			if (title !== record.definition.questions[0]!.question) {
				room.projectPrompt(stagedDocument, id, question.id, title);
			}
			if (added.length > 0) room.projectOptions(stagedDocument, id, question);
			let mutation: room.Mutation = {
				update: Y.encodeStateAsUpdate(stagedDocument.doc, vector),
				source: room.project(stagedDocument),
			};
			beforePublish?.();
			await Service.publishStaged(plan, server, roomId, {
				...plan,
				document: stagedDocument,
				questions: stagedQuestions,
				records: new Map(plan.records).set(id, {
					...record,
					definition,
					optionOrigins: origins,
				}),
				threads: new Map(plan.threads),
				outlines: new Map(plan.outlines),
				pendingCardActions: actions,
			}, mutation);
			broadcast(server, roomId, {
				kind: "question:changed",
				ts: 0,
				id,
				definition,
				revision: final.revision,
			});
			announce(plan, server, roomId, id);
			for (let option of added) {
				emit(plan, {
					kind: "option-added",
					id,
					...(record.threadId ? { threadId: record.threadId } : {}),
					actor: "chopin",
					optionId: option.id,
					label: option.label,
					origin: "planner",
				});
			}
			return { title, added: added.map(option => option.id) };
		} finally {
			Store.releaseEdit(originalQuestions, id);
			stagedDocument?.doc.destroy();
		}
	};
	return locked ? body() : Service.exclusive(plan, body);
}
