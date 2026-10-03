import { ULID } from "@chopin/dialect";
import * as Question from "@chopin/question";
import { assertSourceShape } from "./sources";
import type { Effect } from "./effect-types";
import { bounded, invalid, MAX_EFFECTS, object, scopedKey } from "./effect-fields";
// Extracted from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.ts.

export function restoreEffectOutbox(pendingValue: unknown, receiptValue: unknown): {
	pending: Effect[];
	receipts: string[];
} {
	let pending = pendingValue === undefined ? [] : pendingValue;
	let receipts = receiptValue === undefined ? [] : receiptValue;
	if (
		!Array.isArray(pending) || pending.length > MAX_EFFECTS
		|| !Array.isArray(receipts) || receipts.length > MAX_EFFECTS
	) return invalid();
	let keys = new Set<string>();
	for (let raw of pending) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
		let base = raw as Record<string, unknown>;
		if (!bounded(base.key, 300) || keys.has(base.key)) return invalid();
		keys.add(base.key);
		let item: Record<string, unknown>;
		if (base.kind === "insert-card") {
			item = object(raw, ["key", "kind", "threadId", "header", "question", "options", "trigger"]);
			if (
				item.key !== `insert:${item.threadId}` || !bounded(item.threadId, 200)
				|| !bounded(item.header, Question.limits.MAX_HEADER)
				|| !bounded(item.question, 500) || !bounded(item.trigger, 200)
				|| !Array.isArray(item.options)
				|| item.options.length > Question.limits.MAX_DECISION_OPTIONS
			) return invalid();
			let ids = new Set<string>();
			for (let rawOption of item.options) {
				let option = object(rawOption, ["id", "label"], ["source"]);
				if (
					typeof option.id !== "string" || !ULID.test(option.id)
					|| !bounded(option.label, Question.limits.MAX_LABEL)
					|| ids.has(option.id as string)
				) return invalid();
				if (option.source !== undefined) {
					try {
						assertSourceShape(option.source);
						if (option.source.role !== "option") return invalid();
					} catch {
						return invalid();
					}
				}
				ids.add(option.id as string);
			}
		} else if (base.kind === "add-option") {
			item = object(raw, ["key", "kind", "threadId", "optionId", "label", "trigger"], [
				"source",
			]);
			if (
				item.key !== `option:${item.optionId}` || !bounded(item.threadId, 200)
				|| typeof item.optionId !== "string" || !ULID.test(item.optionId)
				|| !bounded(item.label, Question.limits.MAX_LABEL)
				|| !bounded(item.trigger, 200)
			) return invalid();
			if (item.source !== undefined) {
				try {
					assertSourceShape(item.source);
					if (item.source.role !== "option") return invalid();
				} catch {
					return invalid();
				}
			}
		} else if (base.kind === "suggest") {
			item = object(raw, ["key", "kind", "threadId", "messageIds"], ["optionId"]);
			if (
				!String(item.key).startsWith("suggest:") || !bounded(item.threadId, 200)
				|| item.optionId !== undefined
					&& (typeof item.optionId !== "string" || !ULID.test(item.optionId))
				|| !Array.isArray(item.messageIds) || item.messageIds.length > 8
				|| item.messageIds.some(id => !bounded(id, 200))
				|| item.optionId === undefined && item.messageIds.length !== 0
			) return invalid();
		} else if (base.kind === "prompt") {
			item = object(raw, ["key", "kind", "threadId", "messageId", "generation"], [
				"optionId",
				"sourceMessageIds",
			]);
			if (
				!String(item.key).startsWith("prompt:") || String(item.key).length <= 7
				|| !bounded(item.threadId, 200)
				|| item.optionId !== undefined
					&& (typeof item.optionId !== "string" || !ULID.test(item.optionId))
				|| !bounded(item.messageId, 200)
				|| !Number.isSafeInteger(item.generation) || (item.generation as number) < 0
				|| item.sourceMessageIds !== undefined && (
						!Array.isArray(item.sourceMessageIds) || item.sourceMessageIds.length > 8
						|| item.sourceMessageIds.some(id => !bounded(id, 200))
						|| new Set(item.sourceMessageIds).size !== item.sourceMessageIds.length
					)
			) return invalid();
		} else if (base.kind === "defer-prompt") {
			item = object(raw, ["key", "kind", "threadId", "proposalId", "deferredEventId"]);
			if (
				!bounded(item.threadId, 200) || !bounded(item.proposalId, 200)
				|| !bounded(item.deferredEventId, 200)
				|| item.key !== `defer-prompt:${item.deferredEventId}`
			) return invalid();
		} else if (base.kind === "scoped-choice") {
			item = object(raw, [
				"key",
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
			]);
			if (
				!bounded(item.threadId, 200) || !bounded(item.proposalId, 200)
				|| !bounded(item.cardId, 200) || !ULID.test(item.optionId as string)
				|| !bounded(item.label, Question.limits.MAX_LABEL) || item.scope !== "spike"
				|| !Number.isSafeInteger(item.generation) || (item.generation as number) < 0
				|| !bounded(item.triggerEventId, 200)
				|| item.key !== scopedKey(item.proposalId, item.triggerEventId)
				|| !Array.isArray(item.sources)
				|| item.sources.length !== (item.triggerEventId === item.proposalId ? 1 : 2)
			) return invalid();
			try {
				for (let [index, source] of (item.sources as unknown[]).entries()) {
					assertSourceShape(source);
					if (
						source.author.kind !== "member"
						|| index === 0 && source.role !== "support"
						|| index === 1 && !["support", "objection", "withdrawal"].includes(source.role)
					) return invalid();
				}
			} catch {
				return invalid();
			}
		} else if (base.kind === "research") {
			item = object(raw, ["key", "kind", "offerId"]);
			if (!bounded(item.offerId, 200) || item.key !== `research:${item.offerId}`) {
				return invalid();
			}
		} else if (base.kind === "job") {
			item = object(raw, ["key", "kind", "intent"], ["threadId"]);
			let intent = object(item.intent, ["kind", "target", "trigger"]);
			if (
				!String(item.key).startsWith("job:")
				|| item.threadId !== undefined && !bounded(item.threadId, 200)
				|| intent.kind === "prose" && !bounded(item.threadId, 200)
				|| !["heading", "refine", "suggest", "prose"].includes(intent.kind as string)
				|| !bounded(intent.target, 200) || !bounded(intent.trigger, 200)
			) return invalid();
		} else return invalid();
	}
	let receiptKeys = new Set<string>();
	for (let key of receipts) {
		if (!bounded(key, 300) || receiptKeys.has(key) || keys.has(key)) return invalid();
		receiptKeys.add(key);
	}
	return { pending: pending as Effect[], receipts: receipts as string[] };
}
