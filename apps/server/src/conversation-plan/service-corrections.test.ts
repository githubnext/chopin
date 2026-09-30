import { expect, test } from "bun:test";

import type { Effect } from "./effects";

import { createProcessor } from "./service";

import { excerptAction, excerptCorrectionSetup } from "./service-correction.test-fixtures";

// Whole callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
test("a human can add a saved subspan and persist its option effect before publication", async () => {
	let { setup, excerpt, start, end } = excerptCorrectionSetup();
	let effectsAtPublish: Effect[][] = [];
	let publish = setup.dependencies.publish;
	setup.dependencies.publish = state => {
		effectsAtPublish.push(structuredClone(setup.durable.pending));
		publish(state);
	};
	let processor = createProcessor(setup.dependencies);
	let action = excerptAction(setup.plan.conversationPlan, excerpt, start, end, {
		contributionKind: "option",
	});
	let result = await processor.correct(action, { kind: "member", handle: "bob" });
	let saved = setup.durable.state;
	let event = saved.events.at(-1);
	let quote = excerpt.text.slice(start, end);
	expect(result).toEqual({ eventId: "human:bob:add-excerpt", revision: saved.revision });
	expect(event).toMatchObject({
		type: "option.added",
		origin: "human",
		actor: { kind: "member", handle: "bob" },
		source: {
			messageId: excerpt.id,
			author: excerpt.author,
			quote,
			start,
			end,
			role: "option",
		},
		contribution: { text: quote, authoring: "quoted" },
	});
	expect(saved.threads[0]?.contributions.at(-1)).toMatchObject({
		text: quote,
		actor: { kind: "member", handle: "bob" },
		sources: [{ messageId: excerpt.id, author: excerpt.author, quote, start, end }],
	});
	expect(setup.durable.pending).toMatchObject([{
		kind: "add-option",
		threadId: "thread-a",
		optionId: expect.any(String),
		label: quote,
		trigger: event?.id,
	}]);
	expect(effectsAtPublish).toEqual([setup.durable.pending]);
	expect(setup.publications).toEqual([saved]);
	await expect(processor.correct(action, { kind: "member", handle: "bob" })).resolves.toEqual(
		result,
	);
	expect(setup.plan.conversationPlan.events.filter(item => item.id === result.eventId))
		.toHaveLength(1);
	expect(setup.publications).toHaveLength(1);
});

test.each(
	[
		{
			name: "the selected range lies outside the reviewed outcome",
			setup: { outcomeRange: [0, 4] as [number, number] },
			change: { contributionKind: "reason", targetOptionId: "01K0N4W3B7P27CBAEC7A8C8WEB" },
			expected: /outcome|range|review/i,
		},
		{
			name: "the analysis has no held outcome",
			setup: { outcome: "missing" as const },
			change: { contributionKind: "reason" },
			expected: /outcome|review|held/i,
		},
		{
			name: "the analysis outcome has already been accepted",
			setup: { outcome: "accepted" as const },
			change: { contributionKind: "reason" },
			expected: /outcome|review|held/i,
		},
		{
			name: "the expected thread version is stale",
			setup: {},
			stale: true,
			change: { contributionKind: "reason" },
			expected: /stale/i,
		},
		{
			name: "the destination thread is closed",
			setup: { threadStatus: "discarded" as const },
			change: { contributionKind: "reason" },
			expected: /open|closed|discarded/i,
		},
		{
			name: "the target option does not exist",
			setup: {},
			change: { contributionKind: "reason", targetOptionId: "missing-option" },
			expected: /target|option/i,
		},
		{
			name: "the source span has already been corrected",
			setup: { duplicateSource: true },
			change: { contributionKind: "reason" },
			expected: /duplicate|already|source/i,
		},
		{
			name: "the request supplies a forged quote",
			setup: {},
			change: { contributionKind: "reason", quote: "invented excerpt" },
			expected: /unknown|quote|source/i,
		},
	] as const,
)("rejects excerpt correction when $name", async item => {
	let { setup, excerpt, start, end } = excerptCorrectionSetup(item.setup);
	let before = structuredClone(setup.plan.conversationPlan);
	let action = excerptAction(setup.plan.conversationPlan, excerpt, start, end, item.change);
	if ("stale" in item && item.stale) action.expectedVersion--;
	let processor = createProcessor(setup.dependencies);
	await expect(processor.correct(action, { kind: "member", handle: "bob" }))
		.rejects.toThrow(item.expected);
	expect(setup.plan.conversationPlan).toEqual(before);
	expect(setup.publications).toEqual([]);
});
