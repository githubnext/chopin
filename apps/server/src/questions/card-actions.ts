import { ULID } from "@chopin/dialect";
import * as Question from "@chopin/question";

import type { Record as CardRecord } from "./records";
import type { CardEvent } from "./card-event";

const MAX_PENDING_CARD_ACTIONS = 1024;
const MAX_DECISION_TEXT = 500;

type Base = {
	id: string;
	cardId: string;
	threadId: string;
	actor: string;
	at: number;
};

/** Stable identity of the currently saved decision; reopen records the prior answer in history. */
export function decisionGeneration(record: Pick<CardRecord, "history">): number {
	return record.history.length + 1;
}

export function proseJobTrigger(cardId: string, generation: number): string {
	return `decided:${cardId}:${generation}`;
}

export type PendingCardAction =
	& Base
	& (
		| { kind: "decided"; generation: number; optionIds: string[]; text: string }
		| { kind: "reopened"; generation: number }
		| { kind: "discarded" }
		| { kind: "option-added"; optionId: string; label: string; origin: "human" | "planner" }
	);

/** Capture the event before the card's fenced commit, using card history rather than observer state. */
export function captureCardAction(
	record: CardRecord,
	event: CardEvent,
	at: number,
	text?: string,
): PendingCardAction | undefined {
	if (!record.threadId) return;
	if (event.id !== record.id) throw new Error("card action does not match its record");
	let base = {
		cardId: record.id,
		threadId: record.threadId,
		actor: event.actor,
		at,
	};
	switch (event.kind) {
		case "decided": {
			if (!text) throw new Error("card decision text is missing");
			let generation = decisionGeneration(record);
			let summary = text.length > MAX_DECISION_TEXT
				? `${text.slice(0, MAX_DECISION_TEXT - 1).replace(/[\uD800-\uDBFF]$/, "")}…`
				: text;
			return {
				...base,
				id: `card:${record.id}:decided:${generation}`,
				kind: "decided",
				generation,
				optionIds: [...event.optionIds],
				text: summary,
			};
		}
		case "reopened": {
			let generation = decisionGeneration(record);
			return {
				...base,
				id: `card:${record.id}:reopened:${generation}`,
				kind: "reopened",
				generation,
			};
		}
		case "discarded":
			return { ...base, id: `card:${record.id}:discarded`, kind: "discarded" };
		case "option-added":
			if (event.origin === "chat") return;
			return {
				...base,
				id: `card:${record.id}:option:${event.optionId}`,
				kind: "option-added",
				optionId: event.optionId,
				label: event.label,
				origin: event.origin,
			};
	}
}

export function appendCardAction(
	pending: readonly PendingCardAction[],
	action: PendingCardAction | undefined,
): PendingCardAction[] {
	if (!action) return [...pending];
	if (pending.some(item => item.id === action.id)) throw new Error("duplicate pending card action");
	if (pending.length >= MAX_PENDING_CARD_ACTIONS) throw new Error("pending card actions are full");
	return [...pending, action];
}

function invalid(): never {
	throw new Error("hosted channel has invalid card actions");
}

function bounded(value: unknown, max: number): value is string {
	return typeof value === "string" && !!value.trim() && value.length <= max;
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).sort().join(",") === keys.sort().join(",");
}

/** Legacy sidecars may omit the queue; present entries must be complete and strictly bounded. */
export function restorePendingCardActions(value: unknown): PendingCardAction[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_PENDING_CARD_ACTIONS) invalid();
	let ids = new Set<string>();
	for (let raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
		let item = raw as Record<string, unknown>;
		let base = ["id", "cardId", "threadId", "actor", "at", "kind"];
		if (
			!bounded(item.cardId, 200) || !ULID.test(item.cardId)
			|| !bounded(item.threadId, 200) || !bounded(item.actor, 200)
			|| !Number.isSafeInteger(item.at) || (item.at as number) < 0
			|| !bounded(item.id, 200) || ids.has(item.id)
		) invalid();
		ids.add(item.id);
		if (item.kind === "decided") {
			if (
				!exact(item, [...base, "generation", "optionIds", "text"])
				|| !Number.isSafeInteger(item.generation) || (item.generation as number) < 1
				|| item.id !== `card:${item.cardId}:decided:${item.generation}`
				|| !Array.isArray(item.optionIds)
				|| item.optionIds.length > Question.limits.MAX_DECISION_OPTIONS
				|| item.optionIds.some(id => typeof id !== "string" || !ULID.test(id))
				|| new Set(item.optionIds).size !== item.optionIds.length
				|| !bounded(item.text, MAX_DECISION_TEXT)
			) invalid();
		} else if (item.kind === "reopened") {
			if (
				!exact(item, [...base, "generation"])
				|| !Number.isSafeInteger(item.generation) || (item.generation as number) < 1
				|| item.id !== `card:${item.cardId}:reopened:${item.generation}`
			) invalid();
		} else if (item.kind === "discarded") {
			if (!exact(item, base) || item.id !== `card:${item.cardId}:discarded`) invalid();
		} else if (item.kind === "option-added") {
			if (
				!exact(item, [...base, "optionId", "label", "origin"])
				|| typeof item.optionId !== "string" || !ULID.test(item.optionId)
				|| item.id !== `card:${item.cardId}:option:${item.optionId}`
				|| !bounded(item.label, Question.limits.MAX_LABEL)
				|| !["human", "planner"].includes(item.origin as string)
			) invalid();
		} else invalid();
	}
	return value as PendingCardAction[];
}
