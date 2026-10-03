import { ULID, ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";
import * as Y from "yjs";
import { isDeepStrictEqual } from "node:util";

import { applyEvent } from "../conversation-plan/events";
import { OptionCapacityError } from "../conversation-plan/option-capacity";

import { isOpenStatus, matchesQuestionSource, questionMentionsOption } from "./records";
import { atomicOptionQuote } from "./option-match";

import * as room from "../plan/room";
import * as Store from "./store";

import { validateSource } from "../conversation-plan/sources";
import { broadcast } from "../wire";
import type { Server } from "bun";
import type { ConversationPlan } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";

import { announce, emit, pending } from "./card-notifications";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export async function addServerOption(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	id: string,
	input: {
		optionId?: string;
		label: string;
		origin: "chat" | "planner";
		rationale?: string;
		source?: ConversationPlan.SourceRef;
		trigger?: string;
	},
	locked = false,
	beforePublish?: () => void,
): Promise<
	{ ok: true; optionId: string } | {
		ok: false;
		reason: "full" | "duplicate" | "invalid" | "closed";
	}
> {
	let body = async () => {
		if (Service.implementationActive(plan)) {
			return { ok: false as const, reason: "closed" as const };
		}
		let record = plan.records.get(id);
		let live = Store.get(plan.questions, id);
		if (!record || !isOpenStatus(record.status) || !live || live.claim) {
			return { ok: false as const, reason: "closed" as const };
		}
		if (
			typeof input.label !== "string" || !input.label.trim()
			|| typeof input.optionId !== "undefined" && !ULID.test(input.optionId)
			|| input.rationale !== undefined && (typeof input.rationale !== "string"
					|| !input.rationale.trim() || input.rationale.length > 1_000)
		) return { ok: false as const, reason: "invalid" as const };
		if (input.source !== undefined) {
			try {
				if (
					input.origin === "chat" && (
						input.source.role !== "option"
						|| !plan.conversationPlan.events.some(event =>
							event.id === input.trigger && event.type === "option.added"
							&& event.threadId === record.threadId
							&& event.contribution.id === input.optionId
							&& event.contribution.text.trim().slice(0, Question.limits.MAX_LABEL)
								=== input.label.trim()
							&& isDeepStrictEqual(event.source, input.source)
						)
					)
				) return { ok: false as const, reason: "invalid" as const };
				if (
					input.origin === "planner" && (
						input.source.author.kind !== "member"
						|| input.source.role === "option"
							&& !atomicOptionQuote(input.source.quote, input.label)
					)
				) return { ok: false as const, reason: "invalid" as const };
				let thread = plan.conversationPlan.threads.find(item =>
					item.id === record.threadId && item.questionnaireId === id
				);
				if (
					input.origin === "planner" && (
						input.source.role !== "option"
						&& (!matchesQuestionSource(input.source, thread)
							|| !questionMentionsOption(input.source.quote, input.label))
					)
				) {
					return { ok: false as const, reason: "invalid" as const };
				}
				let message = plan.chat.entries.find(entry => entry.id === input.source?.messageId);
				if (!message) return { ok: false as const, reason: "invalid" as const };
				validateSource(input.source, message);
			} catch {
				return { ok: false as const, reason: "invalid" as const };
			}
		}
		let already = record.definition.questions[0]?.options.find(option =>
			option.id === input.optionId
		);
		if (already) {
			let provenance = record.optionOrigins[already.id];
			if (
				already.label === input.label.trim() && provenance?.origin === input.origin
				&& provenance.rationale === input.rationale
				&& JSON.stringify(provenance.source) === JSON.stringify(input.source)
			) return { ok: true as const, optionId: already.id };
			return { ok: false as const, reason: "invalid" as const };
		}
		let originalQuestions = plan.questions;
		if (!Store.reserveOption(originalQuestions, id)) {
			return { ok: false as const, reason: "closed" as const };
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
			let added = Store.addOption(stagedQuestions, id, input.optionId ?? ulid(), input.label);
			if (!added.ok) return { ok: false as const, reason: added.reason };
			stagedDocument = await room.restore(
				plan.document.epoch,
				Y.encodeStateAsUpdate(plan.document.doc),
				room.project(plan.document),
				[],
			);
			stagedDocument.seq = plan.document.seq;
			let records = new Map(plan.records);
			records.set(id, {
				...record,
				definition: added.definition,
				optionOrigins: {
					...record.optionOrigins,
					[added.option.id]: {
						origin: input.origin,
						...(input.rationale ? { rationale: input.rationale } : {}),
						...(input.source ? { source: input.source } : {}),
					},
				},
			});
			let mutation = room.projectOptions(
				stagedDocument,
				id,
				added.definition.questions[0],
			);
			let thread = plan.conversationPlan.threads.find(item =>
				item.id === record.threadId && item.questionnaireId === id
			);
			let optionEvent: ConversationPlan.Event | undefined = input.origin === "planner" && thread
				? {
					id: `card:${id}:option:${added.option.id}`,
					type: "option.added",
					threadId: thread.id,
					observedThreadVersion: thread.version,
					origin: "planner",
					actor: { kind: "agent" },
					at: Math.floor(Date.now() / 1_000),
					...(input.source?.role === "option" ? { source: input.source } : {}),
					contribution: {
						id: added.option.id,
						text: added.option.label,
						authoring: "scribe",
						targetId: thread.id,
					},
				}
				: undefined;
			let conversationPlan = optionEvent
				? applyEvent(plan.conversationPlan, optionEvent)
				: plan.conversationPlan;
			beforePublish?.();
			await Service.publishStaged(plan, server, roomId, {
				...plan,
				document: stagedDocument,
				questions: stagedQuestions,
				records,
				conversationPlan,
				pendingCardActions: optionEvent ? plan.pendingCardActions : pending(plan, record, {
					kind: "option-added",
					id,
					actor: "chopin",
					optionId: added.option.id,
					label: added.option.label,
					origin: input.origin,
				}),
			}, mutation);
			broadcast(server, roomId, {
				kind: "question:changed",
				ts: 0,
				id,
				definition: added.definition,
				revision: added.revision,
			});
			if (optionEvent) {
				broadcast(server, roomId, {
					kind: "conversation-plan:changed",
					ts: 0,
					state: conversationPlan,
				});
			}
			announce(plan, server, roomId, id);
			if (input.origin === "planner") {
				emit(plan, {
					kind: "option-added",
					id,
					...(record.threadId ? { threadId: record.threadId } : {}),
					actor: "chopin",
					optionId: added.option.id,
					label: added.option.label,
					origin: "planner",
				});
			}
			return { ok: true as const, optionId: added.option.id };
		} finally {
			Store.releaseOption(originalQuestions, id);
			stagedDocument?.doc.destroy();
		}
	};
	try {
		return await (locked ? body() : Service.exclusive(plan, body));
	} catch (error) {
		if (error instanceof OptionCapacityError) return { ok: false, reason: error.reason };
		throw error;
	}
}
