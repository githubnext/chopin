import { ULID, ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";
import * as Y from "yjs";
import { isDeepStrictEqual } from "node:util";

import * as room from "../plan/room";
import * as Store from "./store";

import { validateSource } from "../conversation-plan/sources";
import { broadcast } from "../wire";
import type { Server } from "bun";
import type { ConversationPlan } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";

import { announce } from "./card-notifications";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export async function insertConversationCard(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	input: {
		threadId: string;
		header: string;
		question: string;
		options: Array<{ id: string; label: string; source?: ConversationPlan.SourceRef }>;
	},
): Promise<string> {
	let found = [...plan.records.values()].find(record => record.threadId === input.threadId);
	if (found) return found.id;
	return Service.exclusive(plan, async () => {
		if (Service.implementationActive(plan)) throw new Error("implementation is active");
		let existing = [...plan.records.values()].find(record => record.threadId === input.threadId);
		if (existing) return existing.id;
		let id = ulid();
		let questionId = ulid();
		let options = input.options.slice(0, Question.limits.MAX_DECISION_OPTIONS).map(option => {
			if (!ULID.test(option.id)) Question.reject("Conversation option ID is invalid");
			if (option.source) {
				if (
					option.source.role !== "option"
					|| !plan.conversationPlan.events.some(event =>
						event.type === "option.added" && event.threadId === input.threadId
						&& event.contribution.id === option.id
						&& event.contribution.text.trim().slice(0, Question.limits.MAX_LABEL)
							=== option.label.trim()
						&& isDeepStrictEqual(event.source, option.source)
					)
				) Question.reject("Conversation option source is invalid");
				let entry = plan.chat.entries.find(item => item.id === option.source?.messageId);
				if (!entry) Question.reject("Conversation option source is missing");
				validateSource(option.source, entry);
			}
			return {
				id: option.id,
				label: option.label.slice(0, Question.limits.MAX_LABEL),
				description: "",
			};
		});
		let single = Question.decision(Question.identified({
			questions: [{
				id: questionId,
				header: input.header.slice(0, Question.limits.MAX_HEADER),
				question: input.question.slice(0, Question.limits.MAX_QUESTION),
				multiple: false,
				options,
			}],
		}));
		let stagedDocument = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			room.project(plan.document),
			[],
		);
		stagedDocument.seq = plan.document.seq;
		try {
			let stagedQuestions: Store.Questions = {
				open: new Map(plan.questions.open),
				closed: new Map(plan.questions.closed),
			};
			Store.reopen(stagedQuestions, id, single, id);
			let records = new Map(plan.records);
			records.set(id, {
				id,
				definition: single,
				status: "open",
				origin: "conversation",
				threadId: input.threadId,
				history: [],
				optionOrigins: Object.fromEntries(options.map(option => {
					let source = input.options.find(item => item.id === option.id)?.source;
					return [option.id, { origin: "chat", ...(source ? { source } : {}) }];
				})),
				editors: [],
			});
			let mutation = room.insertQuestionnaires(stagedDocument, [{
				value: {
					id,
					thread: input.threadId,
					status: "open",
					questions: [{
						id: questionId,
						header: single.questions[0].header,
						prompt: single.questions[0].question,
						multiple: false,
						options: options.map(option => ({ id: option.id, label: option.label })),
					}],
				},
			}]);
			if (!mutation) throw new Error("conversation card could not be inserted");
			await Service.publishStaged(plan, server, roomId, {
				...plan,
				document: stagedDocument,
				questions: stagedQuestions,
				records,
			}, mutation);
		} finally {
			stagedDocument.doc.destroy();
		}
		broadcast(server, roomId, {
			kind: "question:asked",
			ts: 0,
			id,
			definition: single,
			widget: id,
		});
		announce(plan, server, roomId, id);
		return id;
	});
}
