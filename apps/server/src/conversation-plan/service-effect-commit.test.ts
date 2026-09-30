import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState, restoreState } from "./domain";

import type { Effect } from "./effects";

import { createProcessor, MAX_PENDING_EFFECTS } from "./service";

import { entry, harness, opened, until } from "./service.test-fixtures";

// Whole callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
test("analysis persists an insert intent before delivery and a new processor drains it", async () => {
	let setup = harness(async ({ message }) => ({
		events: [opened(message)],
		analysis: {
			questionSetVersion: "conversation-plan-4",
			modelVersion: "fake",
			status: "applied",
			passes: [],
		},
	}));
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("one", "Which auth system?"));
	processor.afterMessage();
	await until(() => setup.durable.state.queue.length === 0);
	expect(setup.durable.pending).toMatchObject([{ key: "insert:thread-a" }]);
	expect(setup.durable.receipts).toEqual([]);
	processor.stop();

	let restored = harness();
	restored.plan.chat.entries = structuredClone(setup.durable.entries);
	restored.plan.conversationPlan = restoreState(setup.durable.state, restored.plan.chat.entries);
	restored.plan.conversationPlanPendingEffects = structuredClone(setup.durable.pending);
	let resumed = createProcessor(restored.dependencies);
	let calls: string[] = [];
	resumed.setEffects({
		target: () => ({ kind: "unlinked" }),
		insertCard: async () => (calls.push("insert"), "Q"),
		link: async () => void calls.push("link"),
		addOption: async () => {},
		suggest: async () => {},
		prompt: async () => {},
		report: error => restored.errors.push(error),
	});
	resumed.wake();
	await until(() => restored.durable.receipts.includes("insert:thread-a"));
	expect(calls).toEqual(["insert", "link"]);
	expect(restored.durable.pending).toEqual([]);
});

test("a linked event commits a separate refine intent; missing job sink leaves it pending", async () => {
	let setup = harness();
	let source = entry("seed", "Which auth system?");
	setup.plan.chat.entries.push(source);
	setup.plan.conversationPlan = applyInference(initialState(), opened(source), source);
	let processor = createProcessor(setup.dependencies);
	expect(
		await processor.record(state => ({
			id: "card:Q:linked",
			type: "card.linked",
			threadId: "thread-a",
			observedThreadVersion: state.threads[0].version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 1001,
			questionnaireId: "Q",
		})),
	).toBe(true);
	expect(setup.durable.pending).toMatchObject([{
		key: "job:refine:Q",
		intent: { kind: "refine", target: "Q" },
	}]);
	processor.wake();
	await Bun.sleep(2);
	expect(setup.durable.pending).toHaveLength(1);
	expect(setup.durable.receipts).toEqual([]);
});

test("mirrored card actions acknowledge FIFO with the event and roll back together", async () => {
	let setup = harness();
	let source = entry("seed", "Which auth system?");
	setup.plan.chat.entries.push(source);
	setup.plan.conversationPlan = applyInference(initialState(), opened(source), source);
	let cardId = "01K0N4W3B7P27CBAEC7A8C8WEA";
	let options = ["01K0N4W3B7P27CBAEC7A8C8WEB", "01K0N4W3B7P27CBAEC7A8C8WEC"];
	setup.plan.pendingCardActions = options.map((optionId, index) => ({
		id: `card:${cardId}:option:${optionId}`,
		cardId,
		threadId: "thread-a",
		actor: index ? "ben" : "ana",
		at: index + 1,
		kind: "option-added" as const,
		optionId,
		label: `Option ${index}`,
		origin: "human" as const,
	}));
	let processor = createProcessor(setup.dependencies);
	let make = (index: number) => (state: ConversationPlan.State): ConversationPlan.Event => ({
		id: `card:${cardId}:option:${options[index]}`,
		type: "option.added",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "human",
		actor: { kind: "member", handle: index ? "ben" : "ana" },
		at: index + 1,
		contribution: {
			id: options[index]!,
			text: `Option ${index}`,
			authoring: "human-edited",
			targetId: "thread-a",
		},
	});
	let first = setup.plan.pendingCardActions[0]!.id;
	let second = setup.plan.pendingCardActions[1]!.id;
	await expect(processor.record(make(1), second)).rejects.toThrow(/FIFO/);
	setup.fail();
	await expect(processor.record(make(0), first)).rejects.toThrow("storage failed");
	expect(setup.plan.pendingCardActions).toHaveLength(2);
	expect(setup.plan.conversationPlan.threads[0]!.contributions).toHaveLength(0);
	expect(await processor.record(make(0), first)).toBe(true);
	expect(setup.durable.pendingCards.map(item => item.id)).toEqual([second]);
	expect(await processor.record(make(0), first)).toBe(false);
	expect(await processor.record(make(1), second)).toBe(true);
	expect(setup.durable.pendingCards).toEqual([]);
	expect(setup.durable.state.threads[0]!.contributions.map(item => item.id)).toEqual(options);
});

test("a full effect outbox rolls back the analysis rather than dropping an insert", async () => {
	let setup = harness(async ({ message }) => ({
		events: [opened(message)],
		analysis: {
			questionSetVersion: "conversation-plan-4",
			modelVersion: "fake",
			status: "applied",
			passes: [],
		},
	}));
	setup.plan.conversationPlanPendingEffects = Array.from(
		{ length: MAX_PENDING_EFFECTS },
		(_, index): Effect => ({
			key: `job:existing:${index}`,
			kind: "job",
			intent: { kind: "prose", target: "document", trigger: `old-${index}` },
		}),
	);
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("one", "Which auth system?"));
	let published = setup.publications.length;
	processor.afterMessage();
	await until(() => setup.errors.length > 0);
	expect(String(setup.errors[0])).toContain("outbox is full");
	expect(setup.plan.conversationPlan.threads).toEqual([]);
	expect(setup.plan.conversationPlan.queue[0]?.status).toBe("pending");
	expect(setup.plan.conversationPlanPendingEffects).toHaveLength(MAX_PENDING_EFFECTS);
	expect(setup.durable.state.threads).toEqual([]);
	expect(setup.publications).toHaveLength(published + 1);
	processor.stop();
});
