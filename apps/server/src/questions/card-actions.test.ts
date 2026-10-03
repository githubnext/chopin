import { expect, test } from "bun:test";

import {
	captureCardAction,
	decisionGeneration,
	proseJobTrigger,
	restorePendingCardActions,
} from "./card-actions";

import type { Record } from "./records";

const CARD = "01K0N4W3B7P27CBAEC7A8C8WEA";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEB";

function record(history = 0): Record {
	return {
		id: CARD,
		origin: "conversation",
		threadId: "thread-a",
		status: "open",
		definition: { questions: [] },
		history: Array.from({ length: history }, () => ({ choices: [], owner: "ana", at: 1 })),
		optionOrigins: {},
		editors: [],
	} as Record;
}

test("card actions capture immutable generations, actors, times and choices", () => {
	expect(decisionGeneration(record())).toBe(1);
	expect(decisionGeneration(record(1))).toBe(2);
	expect(proseJobTrigger(CARD, decisionGeneration(record(1)))).toBe(`decided:${CARD}:2`);
	let first = captureCardAction(
		record(),
		{
			kind: "decided",
			id: CARD,
			actor: "ana",
			optionIds: [OPTION],
		},
		9,
		"GitHub Apps",
	);
	let reopen = captureCardAction(record(), {
		kind: "reopened",
		id: CARD,
		actor: "ben",
	}, 10);
	let second = captureCardAction(
		record(1),
		{
			kind: "decided",
			id: CARD,
			actor: "cy",
			optionIds: [OPTION],
		},
		11,
		"GitHub Apps",
	);
	expect([first?.id, reopen?.id, second?.id]).toEqual([
		`card:${CARD}:decided:1`,
		`card:${CARD}:reopened:1`,
		`card:${CARD}:decided:2`,
	]);
	expect([first?.actor, reopen?.actor, second?.actor]).toEqual(["ana", "ben", "cy"]);
	expect([first?.at, reopen?.at, second?.at]).toEqual([9, 10, 11]);
	expect(first).toMatchObject({ optionIds: [OPTION], text: "GitHub Apps" });
	expect(restorePendingCardActions([first!, reopen!, second!])).toEqual([
		first!,
		reopen!,
		second!,
	]);
});

test("chat-origin and unlinked cards have no mirror action", () => {
	expect(captureCardAction({ ...record(), threadId: undefined }, {
		kind: "discarded",
		id: CARD,
		actor: "ana",
	}, 9)).toBeUndefined();
	expect(captureCardAction(record(), {
		kind: "option-added",
		id: CARD,
		actor: "chopin",
		origin: "chat",
		optionId: OPTION,
		label: "GitHub Apps",
	}, 9)).toBeUndefined();
});

test("pending action restore rejects duplicates, missing payload and unbounded actors", () => {
	let action = captureCardAction(
		record(),
		{
			kind: "decided",
			id: CARD,
			actor: "ana",
			optionIds: [OPTION],
		},
		9,
		"GitHub Apps",
	)!;
	expect(() => restorePendingCardActions([action, action])).toThrow(/card actions/);
	expect(() => restorePendingCardActions([{ ...action, text: undefined }])).toThrow(
		/card actions/,
	);
	expect(() => restorePendingCardActions([{ ...action, actor: "x".repeat(201) }])).toThrow(
		/card actions/,
	);
});
