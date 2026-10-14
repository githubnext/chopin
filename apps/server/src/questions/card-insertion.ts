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
import type { Effect } from "../conversation-plan/effects";

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
		id?: string;
		threadId: string;
		header: string;
		question: string;
		description?: string;
		options: Array<{ id: string; label: string; source?: ConversationPlan.SourceRef }>;
	},
	publication?: {
		conversationPlan: ConversationPlan.State;
		conversationPlanPendingEffects: Effect[];
		placeAfter?: { index: number; digest: string };
		beforePublish: () => void;
	},
): Promise<string> {
	let found = [...plan.records.values()].find(record => record.threadId === input.threadId);
	if (found) return found.id;
	let insert = async () => {
		if (Service.implementationActive(plan)) throw new Error("implementation is active");
		let existing = [...plan.records.values()].find(record => record.threadId === input.threadId);
		if (existing) return existing.id;
		let id = input.id ?? ulid();
		if (!ULID.test(id)) Question.reject("Conversation card ID is invalid");
		if (plan.records.has(id)) Question.reject("Conversation card ID is already in use");
		if (
			!input.question.trim() || input.question.length > Question.limits.MAX_NEW_QUESTION
			|| /[\r\n\u2028\u2029]/.test(input.question)
		) {
			Question.reject("Conversation question must be 1–100 characters on one line");
		}
		let questionId = ulid();
		let options = input.options.slice(0, Question.limits.MAX_DECISION_OPTIONS).map(option => {
			if (!ULID.test(option.id)) Question.reject("Conversation option ID is invalid");
			if (option.source) {
				let contribution = plan.conversationPlan.threads.find(thread =>
					thread.id === input.threadId
				)
					?.contributions.find(item => item.id === option.id && item.kind === "option");
				let original = plan.conversationPlan.events.find(event =>
					event.type === "option.added"
					&& event.contribution.id === option.id && isDeepStrictEqual(event.source, option.source)
				);
				let correction = plan.conversationPlan.events.findLast(event =>
					event.type === "card.corrected"
					&& event.origin === "human" && event.change.kind === "edit"
					&& event.change.field === "contribution" && event.change.contributionId === option.id
				);
				let label = correction?.type === "card.corrected" && correction.change.kind === "edit"
					? correction.change.text
					: original?.type === "option.added"
					? original.contribution.text
					: undefined;
				if (
					option.source.role !== "option" || !original
					|| label?.trim().slice(0, Question.limits.MAX_LABEL) !== option.label.trim()
					|| contribution
						&& (contribution.text.trim().slice(0, Question.limits.MAX_LABEL) !== option.label.trim()
							|| !contribution.sources.some(source => isDeepStrictEqual(source, option.source)))
					|| !contribution && original.threadId !== input.threadId
				) {
					Question.reject("Conversation option source is invalid");
				}
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
				question: input.question,
				...(input.description !== undefined ? { description: input.description } : {}),
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
				...(publication?.placeAfter ? { at: publication.placeAfter } : {}),
				value: {
					id,
					thread: input.threadId,
					status: "open",
					questions: [{
						id: questionId,
						header: single.questions[0].header,
						prompt: single.questions[0].question,
						...(single.questions[0].description
							? { description: single.questions[0].description }
							: {}),
						multiple: false,
						options: options.map(option => ({ id: option.id, label: option.label })),
					}],
				},
			}]);
			if (!mutation) throw new Error("conversation card could not be inserted");
			publication?.beforePublish();
			await Service.publishStaged(plan, server, roomId, {
				...plan,
				document: stagedDocument,
				questions: stagedQuestions,
				records,
				...(publication
					? {
						conversationPlan: publication.conversationPlan,
						conversationPlanPendingEffects: publication.conversationPlanPendingEffects,
					}
					: {}),
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
		if (publication) {
			broadcast(server, roomId, {
				kind: "conversation-plan:changed",
				ts: 0,
				state: plan.conversationPlan,
			});
		}
		announce(plan, server, roomId, id);
		return id;
	};
	return publication ? insert() : Service.exclusive(plan, insert);
}
