import * as Chat from "../chat/service";

import * as Questions from "../questions/service";

import * as Service from "../plan/service";
import type { Server } from "bun";

import type { Plan } from "../plan/service";

import type { SocketData } from "../wire";
import type { EffectCommands } from "./service";

import { activeSettleDeferral, effectivePreference } from "./preference";

import { promptText, sameSource, shouldPrompt } from "./card-prompts";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations/property nodes; synchronous wrappers only.
export function createCardPrompts(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	announcer: Chat.Announcer,
): Pick<EffectCommands, "prompt" | "deferPrompt"> {
	return {
		prompt: async (id, generation, source) => {
			await Service.exclusive(plan, async () => {
				let record = plan.records.get(id);
				if (!record) throw new Error("prompt card is missing");
				let thread = plan.conversationPlan.threads.find(item => item.id === record.threadId);
				if (thread && activeSettleDeferral(thread, plan.conversationPlan.events)) return;
				if (thread?.status === "reopened" && !thread.pendingSettle) return;
				if (source && thread?.pendingSettle) {
					let events = plan.conversationPlan.events;
					let deferredAt = events.findLastIndex(item =>
						item.type === "settle.deferred" && item.threadId === thread.id
					);
					if (deferredAt >= 0) {
						let triggerAt = events.findLastIndex(item =>
							item.threadId === thread.id && "source" in item
							&& item.source?.messageId === source.messageId
							&& (item.type === "settle.suggested" || item.type === "settle.agreed"
								|| item.type === "settle.resumed" || item.type === "stance.changed")
						);
						if (triggerAt <= deferredAt) return;
					}
					let current = effectivePreference(thread, plan.conversationPlan.events);
					if (source.sourceMessageIds !== undefined) {
						if (!sameSource(current, source.optionId, source.sourceMessageIds)) {
							return;
						}
					} else if (
						current?.optionId !== source.optionId
						|| !current?.messageIds.includes(source.messageId)
					) return;
				}
				let title = record.definition.questions[0]?.question;
				if (!title) throw new Error("prompt card title is missing");
				let identity = source?.sourceMessageIds === undefined ? undefined : {
					optionId: source.optionId,
					messageIds: source.sourceMessageIds,
				};
				if (!shouldPrompt(plan.chat.entries, id, record, generation, identity)) return;
				await Chat.noticeExclusive(announcer, {
					text: promptText(title),
					decision: {
						questionnaireId: id,
						kind: "prompt",
						generation,
						...(identity
							? {
								sourceMessageIds: [...identity.messageIds],
								...(identity.optionId ? { suggestedOptionId: identity.optionId } : {}),
							}
							: {}),
					},
				});
			});
		},
		deferPrompt: async effect => {
			await Service.exclusive(plan, async () => {
				let thread = plan.conversationPlan.threads.find(item => item.id === effect.threadId);
				let deferred = thread && activeSettleDeferral(thread, plan.conversationPlan.events);
				if (
					!thread || !deferred || deferred.id !== effect.deferredEventId
					|| deferred.proposalId !== effect.proposalId || !thread.questionnaireId
				) return;
				let id = thread.questionnaireId;
				let record = plan.records.get(id);
				if (!record || !Questions.isOpenStatus(record.status)) return;
				let title = record.definition.questions[0]?.question;
				if (!title) throw new Error("deferred card title is missing");
				let cleared = await Questions.suggest(plan, server, roomId, id, undefined, true);
				if (!cleared) throw new Error("deferred card is temporarily unavailable");
				for (let entry of plan.chat.entries) {
					if (
						entry.decision?.kind !== "prompt" || entry.decision.questionnaireId !== id
						|| entry.decision.generation !== record.history.length
					) continue;
					await Chat.refreshNoticeExclusive(announcer, entry.id, {
						text: `Decision paused pending verification: ${title}`,
						decision: { questionnaireId: id, kind: "activity" },
					});
				}
			});
		},
	};
}
