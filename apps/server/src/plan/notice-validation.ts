import { isDeepStrictEqual } from "node:util";
import { ULID } from "@chopin/dialect";
import * as Question from "@chopin/question";
import { assertSourceShape, validateSource } from "../conversation-plan/sources";
import type { ConversationPlan } from "@chopin/protocol";
import type * as Chat from "../chat/service";
import type { JsonValue } from "../storage/model";
import type { Record as CardRecord } from "../questions/records";

export function validateNotice(
	entry: Record<string, JsonValue>,
	savedMessages: Map<JsonValue, Record<string, JsonValue>>,
): void {
	if (Object.hasOwn(entry, "decision")) {
		let author = entry.author as Record<string, JsonValue>;
		let decision = entry.decision;
		if (
			author.kind !== "system" || !decision || typeof decision !== "object"
			|| Array.isArray(decision)
		) throw new Error("hosted channel has an invalid transcript entry");
		let value = decision as Record<string, JsonValue>;
		if (value.kind === "scoped-choice") {
			let fields = [
				"questionnaireId",
				"kind",
				"threadId",
				"proposalId",
				"cardId",
				"optionId",
				"label",
				"scope",
				"generation",
				"triggerEventId",
				"sources",
			];
			if (
				Object.keys(value).some(key => !fields.includes(key))
				|| fields.some(key => !Object.hasOwn(value, key))
				|| typeof value.cardId !== "string" || !ULID.test(value.cardId)
				|| value.questionnaireId !== value.cardId
				|| typeof value.optionId !== "string" || !ULID.test(value.optionId)
				|| [value.threadId, value.proposalId, value.triggerEventId].some(id =>
					typeof id !== "string" || !id || id.length > 200
				)
				|| typeof value.label !== "string" || !value.label.trim()
				|| value.label.length > Question.limits.MAX_LABEL
				|| value.scope !== "spike"
				|| !Number.isSafeInteger(value.generation) || (value.generation as number) < 0
				|| !Array.isArray(value.sources)
				|| value.sources.length !== (value.triggerEventId === value.proposalId ? 1 : 2)
			) throw new Error("hosted channel has an invalid transcript entry");
			let sourceIds = new Set<string>();
			for (let rawSource of value.sources) {
				try {
					assertSourceShape(rawSource);
					if (
						rawSource.role !== "support" || rawSource.author.kind !== "member"
						|| sourceIds.has(rawSource.messageId)
					) throw new Error("invalid scoped source");
					let message = savedMessages.get(rawSource.messageId);
					if (!message) throw new Error("missing scoped source message");
					validateSource(rawSource, message as Chat.Chat["entries"][number]);
					sourceIds.add(rawSource.messageId);
				} catch (error) {
					throw new Error("hosted channel has an invalid scoped choice source", {
						cause: error,
					});
				}
			}
		} else if (
			Object.keys(value).some(key =>
				![
					"questionnaireId",
					"kind",
					"generation",
					"label",
					"sourceMessageIds",
					"suggestedOptionId",
				].includes(key)
			)
			|| typeof value.questionnaireId !== "string"
			|| !(value.questionnaireId === "document" || ULID.test(value.questionnaireId))
			|| (value.kind !== "prompt" && value.kind !== "activity")
			|| (Object.hasOwn(value, "label")
				&& (typeof value.label !== "string" || value.label.length > 200))
			|| (value.kind === "prompt" && (
				value.questionnaireId === "document"
				|| !Number.isSafeInteger(value.generation) || (value.generation as number) < 0
				|| (Object.hasOwn(value, "sourceMessageIds") && (
					!Array.isArray(value.sourceMessageIds)
					|| value.sourceMessageIds.length > 8
					|| value.sourceMessageIds.some(id => typeof id !== "string" || !id || id.length > 200)
					|| new Set(value.sourceMessageIds).size !== value.sourceMessageIds.length
				))
				|| (Object.hasOwn(value, "suggestedOptionId") && (
					!Object.hasOwn(value, "sourceMessageIds")
					|| typeof value.suggestedOptionId !== "string"
					|| !ULID.test(value.suggestedOptionId)
				))
			))
			|| (value.kind === "activity" && (
				Object.hasOwn(value, "generation") || Object.hasOwn(value, "sourceMessageIds")
				|| Object.hasOwn(value, "suggestedOptionId")
			))
		) throw new Error("hosted channel has an invalid transcript entry");
	}
}

export function validateScopedNotices(
	transcript: Chat.Chat["entries"],
	conversationPlan: ConversationPlan.State,
	records: CardRecord[],
): void {
	let scopedTriggers = new Set<string>();
	for (let entry of transcript as unknown as Chat.Chat["entries"]) {
		let notice = entry.decision;
		if (notice?.kind !== "scoped-choice") continue;
		let thread = conversationPlan.threads.find(item => item.id === notice.threadId);
		let record = records.find(item => item.id === notice.cardId);
		let proposalIndex = conversationPlan.events.findIndex(item => item.id === notice.proposalId);
		let triggerIndex = conversationPlan.events.findIndex(item => item.id === notice.triggerEventId);
		let proposal = conversationPlan.events[proposalIndex];
		let trigger = conversationPlan.events[triggerIndex];
		if (
			scopedTriggers.has(notice.triggerEventId)
			|| !thread || thread.questionnaireId !== notice.cardId
			|| !record || record.threadId !== notice.threadId
			|| notice.generation > record.history.length
			|| proposal?.type !== "scoped-choice.proposed"
			|| proposal.threadId !== notice.threadId || proposal.cardId !== notice.cardId
			|| proposal.optionId !== notice.optionId || proposal.label !== notice.label
			|| proposal.scope !== notice.scope
			|| triggerIndex < proposalIndex
			|| (trigger?.type !== "scoped-choice.proposed"
				&& trigger?.type !== "scoped-choice.agreed")
			|| trigger.type === "scoped-choice.proposed" && trigger.id !== proposal.id
			|| trigger.type === "scoped-choice.agreed" && (
					trigger.threadId !== notice.threadId || trigger.proposalId !== proposal.id
					|| trigger.cardId !== notice.cardId || trigger.optionId !== notice.optionId
					|| trigger.label !== notice.label || trigger.scope !== notice.scope
				)
			|| !isDeepStrictEqual(notice.sources, [
				proposal.source,
				...(trigger.type === "scoped-choice.agreed" ? [trigger.source] : []),
			])
		) throw new Error("hosted channel has a scoped choice notice without accepted evidence");
		scopedTriggers.add(notice.triggerEventId);
	}
}
