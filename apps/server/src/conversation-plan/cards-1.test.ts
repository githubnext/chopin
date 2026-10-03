import { expect, test } from "bun:test";
import { ulid } from "@chopin/dialect";
import { mirroredEvent, promptText, shouldPrompt } from "./cards";

import type { PendingCardAction } from "../questions/card-actions";

import { base, CARD, OPTION, thread } from "./cards.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("a decided card mirrors its captured actor, choice, text and stable generation", () => {
	let action: PendingCardAction = {
		...base(),
		id: `card:${CARD}:decided:1`,
		kind: "decided",
		generation: 1,
		optionIds: [OPTION],
		text: "GitHub Apps",
	};
	expect(mirroredEvent(thread(), action)).toMatchObject({
		id: action.id,
		type: "decision.recorded",
		threadId: "thread-a",
		observedThreadVersion: 4,
		origin: "human",
		actor: { kind: "member", handle: "ana" },
		at: 9,
		optionId: OPTION,
		text: "GitHub Apps",
		explicit: true,
	});
});

test("reopen, discard and human or Planner options retain their captured identity", () => {
	let reopen: PendingCardAction = {
		...base(),
		id: `card:${CARD}:reopened:1`,
		kind: "reopened",
		generation: 1,
	};
	expect(mirroredEvent(thread("decided"), reopen)).toMatchObject({
		id: reopen.id,
		type: "decision.reopened",
		actor: { kind: "member", handle: "ana" },
	});
	let discard: PendingCardAction = {
		...base(),
		id: `card:${CARD}:discarded`,
		kind: "discarded",
	};
	expect(mirroredEvent(thread(), discard)).toMatchObject({
		id: discard.id,
		type: "thread.discarded",
	});
	let option: PendingCardAction = {
		...base(),
		id: `card:${CARD}:option:01K0N4W3B7P27CBAEC7A8C8WEC`,
		kind: "option-added",
		origin: "human",
		optionId: "01K0N4W3B7P27CBAEC7A8C8WEC",
		label: "Own service",
	};
	expect(mirroredEvent(thread(), option)).toMatchObject({
		id: option.id,
		type: "option.added",
		origin: "human",
		contribution: { id: option.optionId, text: "Own service", authoring: "human-edited" },
	});
	let planner = { ...option, origin: "planner" as const };
	expect(mirroredEvent(thread(), planner)).toMatchObject({
		type: "option.added",
		origin: "planner",
		actor: { kind: "agent" },
		contribution: { authoring: "scribe" },
	});
	expect(mirroredEvent(thread(), { ...option, optionId: OPTION })).toBeUndefined();
});

test("prompt generations distinguish same-second Save and Reopen", () => {
	let entries = [{
		id: "p0",
		author: { kind: "system" as const },
		text: "Ready to decide: Which auth system?",
		ts: 9,
		decision: { questionnaireId: CARD, kind: "prompt" as const, generation: 0 },
	}];
	let open = { status: "open", history: [] };
	let reopened = { status: "reopened", history: [{ at: 9 }] };
	let answered = { status: "answered", history: [] };
	let discarded = { status: "discarded", history: [] };
	let later = { ...entries[0], id: "p1", decision: { ...entries[0].decision, generation: 1 } };
	let other = {
		...entries[0],
		id: "other",
		decision: { ...entries[0].decision, questionnaireId: ulid() },
	};
	expect(promptText("Which auth system?")).toBe("Ready to decide: Which auth system?");
	expect(shouldPrompt([], CARD, open, 0)).toBe(true);
	expect(shouldPrompt(entries, CARD, open, 0)).toBe(false);
	expect(shouldPrompt(entries, CARD, reopened, 0)).toBe(false);
	expect(shouldPrompt(entries, CARD, reopened, 1)).toBe(true);
	expect(shouldPrompt([...entries, later], CARD, reopened, 1)).toBe(false);
	expect(shouldPrompt([other], CARD, open, 0)).toBe(true);
	expect(shouldPrompt([], CARD, answered, 0)).toBe(false);
	expect(shouldPrompt([], CARD, discarded, 0)).toBe(false);
	expect(shouldPrompt(entries, CARD, open, 0, { optionId: OPTION, messageIds: ["m5"] }))
		.toBe(true);
	let sourced = [{
		...entries[0],
		decision: { ...entries[0].decision, suggestedOptionId: OPTION, sourceMessageIds: ["m5"] },
	}];
	expect(shouldPrompt(sourced, CARD, open, 0, { optionId: OPTION, messageIds: ["m5"] }))
		.toBe(false);
	expect(shouldPrompt(sourced, CARD, open, 0, { optionId: OPTION, messageIds: ["m6"] }))
		.toBe(true);
});

test("source-aware prompt retries compare the latest notice, including recurring clears", () => {
	let open = { status: "open", history: [] };
	let notice = (id: string, sourceMessageIds: string[], suggestedOptionId?: string) => ({
		id,
		author: { kind: "system" as const },
		text: "Ready to decide: Which auth system?",
		ts: 9,
		decision: {
			questionnaireId: CARD,
			kind: "prompt" as const,
			generation: 0,
			sourceMessageIds,
			...(suggestedOptionId ? { suggestedOptionId } : {}),
		},
	});
	let bram = { optionId: OPTION, messageIds: ["m5"] };
	let clear = { messageIds: [] };
	let both = notice("both", ["m5", "m6"], OPTION);
	let first = notice("first", ["m5"], OPTION);
	let firstClear = notice("first-clear", []);
	expect(shouldPrompt([first, both], CARD, open, 0, bram)).toBe(true);
	expect(shouldPrompt([first, both, notice("returned", ["m5"], OPTION)], CARD, open, 0, bram))
		.toBe(false);
	expect(shouldPrompt([first, firstClear, notice("new", ["m9"], OPTION)], CARD, open, 0, clear))
		.toBe(true);
	expect(shouldPrompt([first, firstClear], CARD, open, 0, clear)).toBe(false);
});
