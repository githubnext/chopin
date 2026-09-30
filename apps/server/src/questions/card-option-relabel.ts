import * as Y from "yjs";

import { applyEvent } from "../conversation-plan/events";

import { isOpenStatus } from "./records";

import * as room from "../plan/room";
import * as Store from "./store";

import { validateSource } from "../conversation-plan/sources";
import { broadcast } from "../wire";
import type { Server } from "bun";
import type { ConversationPlan } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export async function relabelConversationOption(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	input: {
		operationId: string;
		threadId: string;
		optionId: string;
		label: string;
		expectedThreadVersion: number;
		expectedCardRevision: number;
	},
): Promise<{ eventId: string; revision: number }> {
	return Service.exclusive(plan, async () => {
		if (
			typeof input.operationId !== "string" || !input.operationId
			|| input.operationId.length > 180
		) throw new Error("invalid relabel operation ID");
		let eventId = `option-relabel:${input.operationId}`;
		let previous = plan.conversationPlan.events.find(event => event.id === eventId);
		if (previous) {
			if (
				previous.type !== "option.relabeled" || previous.threadId !== input.threadId
				|| previous.optionId !== input.optionId || previous.label !== input.label
				|| previous.observedThreadVersion !== input.expectedThreadVersion
				|| previous.observedCardRevision !== input.expectedCardRevision
			) {
				throw new Error("relabel operation ID collision");
			}
			return { eventId, revision: plan.conversationPlan.revision };
		}
		if (Service.implementationActive(plan)) throw new Error("implementation is active");
		let thread = plan.conversationPlan.threads.find(item => item.id === input.threadId);
		if (
			!thread || !thread.questionnaireId || thread.version !== input.expectedThreadVersion
			|| thread.status === "decided" || thread.status === "discarded"
		) {
			throw new Error("conversation decision is no longer open and linked");
		}
		let option = thread.contributions.find(item =>
			item.id === input.optionId && item.kind === "option"
		);
		let record = plan.records.get(thread.questionnaireId);
		let live = Store.get(plan.questions, thread.questionnaireId);
		if (
			!option || option.sources.length === 0 || !record || record.origin !== "conversation"
			|| record.threadId !== thread.id || record.optionOrigins[input.optionId]?.origin !== "chat"
			|| !isOpenStatus(record.status) || !live || live.claim
			|| live.revision !== input.expectedCardRevision
			|| record.definition.questions.length !== 1
			|| record.definition.questions[0]?.id !== live.definition.questions[0]?.id
			|| !record.definition.questions[0]?.options.some(item => item.id === input.optionId)
			|| !room.hasQuestionnaire(plan.document, record.id, record.definition.questions[0]!.id)
		) {
			throw new Error("conversation option is no longer editable");
		}
		for (
			let source of [
				...option.sources,
				...(record.optionOrigins[input.optionId]?.source
					? [record.optionOrigins[input.optionId]!.source!]
					: []),
			]
		) {
			let message = plan.chat.entries.find(item => item.id === source.messageId);
			if (!message) throw new Error("option source message is missing");
			validateSource(source, message);
		}
		let event: ConversationPlan.Event = {
			id: eventId,
			type: "option.relabeled",
			threadId: thread.id,
			observedThreadVersion: input.expectedThreadVersion,
			observedCardRevision: input.expectedCardRevision,
			origin: "planner",
			actor: { kind: "agent" },
			at: Date.now(),
			optionId: input.optionId,
			label: input.label,
		};
		let conversationPlan = applyEvent(plan.conversationPlan, event);
		if (!Store.reserveEdit(plan.questions, record.id)) {
			throw new Error("conversation option is no longer editable");
		}
		let stagedDocument: room.Document | undefined;
		try {
			let stagedQuestions: Store.Questions = {
				open: new Map(plan.questions.open),
				closed: new Map(plan.questions.closed),
			};
			stagedQuestions.open.set(record.id, {
				...live,
				claim: undefined,
				editors: new Set(live.editors),
			});
			let relabeled = Store.relabelOption(
				stagedQuestions,
				record.id,
				input.optionId,
				input.label,
				input.expectedCardRevision,
			);
			stagedDocument = await room.restore(
				plan.document.epoch,
				Y.encodeStateAsUpdate(plan.document.doc),
				room.project(plan.document),
				[],
			);
			stagedDocument.seq = plan.document.seq;
			let mutation = room.projectOptions(
				stagedDocument,
				record.id,
				relabeled.definition.questions[0]!,
			);
			if (!mutation) throw new Error("conversation card label was not projected");
			await Service.publishStaged(plan, server, roomId, {
				...plan,
				document: stagedDocument,
				questions: stagedQuestions,
				conversationPlan,
				records: new Map(plan.records).set(record.id, {
					...record,
					definition: relabeled.definition,
				}),
			}, mutation);
			broadcast(server, roomId, {
				kind: "question:changed",
				ts: 0,
				id: record.id,
				definition: relabeled.definition,
				revision: relabeled.revision,
			});
			broadcast(server, roomId, {
				kind: "conversation-plan:changed",
				ts: 0,
				state: conversationPlan,
			});
			return { eventId, revision: conversationPlan.revision };
		} finally {
			Store.releaseEdit(plan.questions, record.id);
			stagedDocument?.doc.destroy();
		}
	});
}
