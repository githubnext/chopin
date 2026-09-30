import { expect, test } from "bun:test";

import { applyInference, initialState } from "./domain";

import type { Effect } from "./effects";

import { createProcessor, MAX_PENDING_EFFECTS } from "./service";

import { entry, harness, opened, until } from "./service.test-fixtures";

// Whole callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
test("failed pre-link option stays ahead of the linked refine job", async () => {
	let setup = harness();
	let source = entry("seed", "Which auth system?");
	setup.plan.chat.entries.push(source);
	setup.plan.conversationPlan = applyInference(initialState(), opened(source), source);
	setup.plan.conversationPlanPendingEffects = [
		{
			key: "insert:thread-a",
			kind: "insert-card",
			threadId: "thread-a",
			header: "Auth",
			question: source.text,
			options: [],
			trigger: "open:seed",
		},
		{
			key: "option:01K0N4W3B7P27CBAEC7A8C8WEA",
			kind: "add-option",
			threadId: "thread-a",
			optionId: "01K0N4W3B7P27CBAEC7A8C8WEA",
			label: "GitHub Apps",
			trigger: "add-1",
		},
	];
	let processor = createProcessor(setup.dependencies);
	let failOption = true;
	let calls: string[] = [];
	processor.setEffects({
		target: id => {
			let thread = setup.plan.conversationPlan.threads.find(item => item.id === id);
			return thread?.questionnaireId
				? { kind: "open", id: thread.questionnaireId }
				: { kind: "unlinked" };
		},
		insertCard: async () => (calls.push("insert"), "Q"),
		link: async (_id, questionnaireId) => {
			calls.push("link");
			await processor.record(state => ({
				id: "card:Q:linked",
				type: "card.linked",
				threadId: "thread-a",
				observedThreadVersion: state.threads[0].version,
				origin: "classifier",
				actor: { kind: "classifier" },
				at: 1001,
				questionnaireId,
			}));
		},
		addOption: async () => {
			calls.push("option");
			if (failOption) throw new Error("option commit failed");
		},
		suggest: async () => {},
		prompt: async () => {},
		enqueueJob: async () => void calls.push("refine"),
		report: error => setup.errors.push(error),
	});
	await until(() => setup.errors.length > 0);
	await Bun.sleep(10);
	let failures = setup.errors.length;
	await Bun.sleep(10);
	expect(setup.errors).toHaveLength(failures);
	expect(calls.slice(0, 2)).toEqual(["insert", "link"]);
	expect(calls.slice(2).every(call => call === "option")).toBe(true);
	expect(calls).not.toContain("refine");
	expect(setup.durable.pending.map(item => item.key)).toEqual([
		"option:01K0N4W3B7P27CBAEC7A8C8WEA",
		"job:refine:Q",
	]);
	expect(setup.durable.receipts).toEqual(["insert:thread-a"]);
	failOption = false;
	processor.wake();
	await until(() => setup.durable.receipts.includes("job:refine:Q"));
	expect(calls.at(-2)).toBe("option");
	expect(calls.at(-1)).toBe("refine");
});

test("legacy unlinked recovery inserts an empty card when old option IDs are unusable", async () => {
	let setup = harness();
	let source = entry("seed", "Which auth system?");
	setup.plan.chat.entries.push(source);
	let state = applyInference(initialState(), opened(source), source);
	setup.plan.conversationPlan = {
		...state,
		threads: [{
			...state.threads[0],
			contributions: [{
				id: "classifier:historical",
				kind: "option",
				text: "GitHub Apps",
				authoring: "quoted",
				sources: [],
				actor: { kind: "classifier" },
			}],
		}],
	};
	let processor = createProcessor(setup.dependencies);
	let seen: Array<{ options: Array<{ id: string; label: string }> }> = [];
	processor.setEffects({
		target: () => ({ kind: "unlinked" }),
		insertCard: async input => (seen.push({ options: input.options }), "Q"),
		link: async () => {},
		addOption: async () => {},
		suggest: async () => {},
		prompt: async () => {},
		report: error => setup.errors.push(error),
	});
	await until(() => setup.durable.receipts.includes("insert:thread-a"));
	expect(seen).toEqual([{ options: [] }]);
	expect(setup.durable.pending).toEqual([]);
});

test("record rolls back the linked event when its refine intent cannot fit", async () => {
	let setup = harness();
	let source = entry("seed", "Which auth system?");
	setup.plan.chat.entries.push(source);
	setup.plan.conversationPlan = applyInference(initialState(), opened(source), source);
	setup.plan.conversationPlanPendingEffects = Array.from(
		{ length: MAX_PENDING_EFFECTS },
		(_, index): Effect => ({
			key: `job:existing:${index}`,
			kind: "job",
			intent: { kind: "prose", target: "document", trigger: `old-${index}` },
		}),
	);
	let processor = createProcessor(setup.dependencies);
	await expect(processor.record(state => ({
		id: "card:Q:linked",
		type: "card.linked",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0].version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1001,
		questionnaireId: "Q",
	}))).rejects.toThrow("outbox is full");
	expect(setup.plan.conversationPlan.threads[0]?.questionnaireId).toBeUndefined();
	expect(setup.plan.conversationPlanPendingEffects).toHaveLength(MAX_PENDING_EFFECTS);
	expect(setup.publications).toEqual([]);
});

test("repeated purpose while jobs are deferred keeps the first heading intent", async () => {
	let setup = harness(async () => ({
		events: [],
		analysis: {
			questionSetVersion: "conversation-plan-4",
			modelVersion: "fake",
			status: "unlinked",
			passes: [{
				stage: "triage",
				answers: {
					enough_purpose: { type: "noul", noul: 0.95 },
				},
			}],
		},
	}));
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("purpose-1", "We are building a private editor."));
	await processor.accept(entry("purpose-2", "It should support collaboration."));
	processor.afterMessage();
	await until(() => setup.durable.state.queue.length === 0 || setup.errors.length > 0);
	expect(setup.errors).toEqual([]);
	expect(setup.durable.pending).toMatchObject([{
		key: "job:heading:document",
		intent: { trigger: "purpose-1" },
	}]);
	expect(setup.durable.pending).toHaveLength(1);
});
