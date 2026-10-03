import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState, restoreState } from "./domain";
import { applyEvent } from "./events";

import { createProcessor } from "./service";

import { deferred, entry, harness, opened, unlinked, until } from "./service.test-fixtures";

// Whole callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
test("card option edits during inference discard the old resolution before publication", async () => {
	let cardId = "01K0N4W3B7P27CBAEC7A8C8WEA";
	let optionId = "01K0N4W3B7P27CBAEC7A8C8WEB";
	let seed = entry("seed", "Which auth system?");
	let choice = entry("choice", "Let's just go with Auth0.");
	let state = applyInference(initialState(), opened(seed), seed);
	state = applyEvent(state, {
		id: "link",
		type: "card.linked",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		questionnaireId: cardId,
	});
	let held = deferred<void>();
	let calls = 0;
	let setup = harness(async input => {
		calls++;
		if (calls > 1) return unlinked();
		expect(input.linkedCards?.get("thread-a")?.options[0]?.label).toBe("Auth0");
		await held.promise;
		let source = {
			messageId: choice.id,
			author: choice.author as ConversationPlan.SourceAuthor,
			quote: choice.text,
			start: 0,
			end: choice.text.length,
		};
		return {
			events: [{
				id: "mirror:choice",
				type: "option.added" as const,
				threadId: "thread-a",
				observedThreadVersion: input.state.threads[0]!.version,
				origin: "classifier" as const,
				actor: { kind: "classifier" as const },
				at: 1000,
				source: { ...source, role: "option" as const },
				contribution: { id: optionId, text: "Auth0", authoring: "scribe" as const },
			}, {
				id: "settle:choice",
				type: "settle.suggested" as const,
				threadId: "thread-a",
				observedThreadVersion: input.state.threads[0]!.version + 1,
				origin: "classifier" as const,
				actor: { kind: "classifier" as const },
				at: 1000,
				source: { ...source, role: "resolution" as const },
				optionId,
			}],
			analysis: {
				questionSetVersion: "test",
				modelVersion: "fake",
				status: "applied" as const,
				passes: [],
			},
		};
	});
	setup.plan.chat.entries.push(seed);
	setup.plan.conversationPlan = state;
	setup.plan.records.set(cardId, {
		id: cardId,
		threadId: "thread-a",
		status: "open",
		history: [],
		definition: { questions: [{ options: [{ id: optionId, label: "Auth0" }] }] },
	} as never);
	let processor = createProcessor(setup.dependencies);
	await processor.accept(choice);
	processor.afterMessage();
	await until(() => calls === 1);
	await setup.dependencies.exclusive(async () => {
		setup.plan.records.get(cardId)!.definition.questions[0]!.options[0]!.label = "Different option";
	});
	held.resolve();
	await until(() =>
		calls === 2 && setup.plan.conversationPlan.analysis.some(item => item.messageId === choice.id)
	);
	expect(setup.plan.conversationPlan.events.some(item => item.id === "mirror:choice")).toBe(false);
	expect(setup.plan.conversationPlanPendingEffects).toEqual([]);
	processor.stop();
});

test("a scoped spike proposal commits before publication without deciding the card", async () => {
	let cardId = "01K0N4W3B7P27CBAEC7A8C8WEA";
	let optionId = "01K0N4W3B7P27CBAEC7A8C8WEB";
	let seed = entry("seed-spike", "Which editor should we use?");
	let choice = entry("choice-spike", "I'd pick Lexical for the spike;");
	let state = applyInference(initialState(), opened(seed), seed);
	state = applyEvent(state, {
		id: "link-spike",
		type: "card.linked",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: seed.ts,
		questionnaireId: cardId,
	});
	let proposed = (version: number): ConversationPlan.Event => ({
		id: "scoped:choice-spike",
		type: "scoped-choice.proposed",
		threadId: "thread-a",
		observedThreadVersion: version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: choice.ts,
		source: {
			messageId: choice.id,
			author: choice.author as ConversationPlan.SourceAuthor,
			quote: choice.text,
			start: 0,
			end: choice.text.length,
			role: "support",
		},
		cardId,
		optionId,
		label: "Lexical",
		scope: "spike",
	});
	let setup = harness(async input => ({
		events: [proposed(input.state.threads[0]!.version)],
		analysis: { questionSetVersion: "test", modelVersion: "fake", status: "applied", passes: [] },
	}));
	setup.plan.chat.entries.push(seed);
	setup.plan.conversationPlan = state;
	setup.plan.records.set(cardId, {
		id: cardId,
		threadId: "thread-a",
		status: "open",
		history: [],
		definition: { questions: [{ options: [{ id: optionId, label: "Lexical" }] }] },
	} as never);
	let processor = createProcessor(setup.dependencies);
	await processor.accept(choice);
	processor.afterMessage();
	await until(() => setup.durable.state.events.some(item => item.id === proposed(0).id));
	let saved = restoreState(setup.durable.state, [seed, choice]);
	expect(saved.threads[0]?.pendingScopedChoice).toMatchObject({
		proposalId: proposed(0).id,
		cardId,
		optionId,
		label: "Lexical",
		scope: "spike",
		proposer: "ana",
		messageId: choice.id,
	});
	expect(saved.threads[0]?.pendingSettle).toBeUndefined();
	expect(saved.threads[0]?.decision).toBeUndefined();
	expect(setup.plan.records.get(cardId)?.status).toBe("open");
	expect(setup.plan.conversationPlanPendingEffects).toEqual([{
		key: "scoped-choice:scoped:choice-spike:proposal",
		kind: "scoped-choice",
		threadId: "thread-a",
		proposalId: "scoped:choice-spike",
		cardId,
		optionId,
		label: "Lexical",
		scope: "spike",
		generation: 0,
		triggerEventId: "scoped:choice-spike",
		sources: [{
			messageId: choice.id,
			author: choice.author as ConversationPlan.SourceAuthor,
			quote: choice.text,
			start: 0,
			end: choice.text.length,
			role: "support",
		}],
	}]);
	expect(setup.publications.some(item => item.events.some(event => event.id === proposed(0).id)))
		.toBe(true);
	let legacy = structuredClone(saved);
	delete legacy.threads[0]!.pendingScopedChoice!.proposalId;
	expect(restoreState(legacy, [seed, choice]).threads[0]?.pendingScopedChoice?.proposalId)
		.toBe(proposed(0).id);
	let ambiguous = applyInference(saved, {
		...proposed(saved.threads[0]!.version),
		id: "scoped:duplicate-spike",
	}, choice);
	delete ambiguous.threads[0]!.pendingScopedChoice!.proposalId;
	expect(() => restoreState(ambiguous, [seed, choice])).toThrow(
		"scoped choice proposal is ambiguous or missing",
	);
	processor.stop();
	let mismatched = harness(async input => ({
		events: [proposed(input.state.threads[0]!.version)],
		analysis: { questionSetVersion: "test", modelVersion: "fake", status: "applied", passes: [] },
	}));
	mismatched.plan.chat.entries.push(seed);
	mismatched.plan.conversationPlan = state;
	mismatched.plan.records.set(cardId, {
		id: cardId,
		threadId: "thread-a",
		status: "open",
		history: [],
		definition: { questions: [{ options: [{ id: optionId, label: "Another editor" }] }] },
	} as never);
	let rejected = createProcessor(mismatched.dependencies);
	await rejected.accept(choice);
	rejected.afterMessage();
	await until(() => mismatched.durable.state.analysis.some(item => item.messageId === choice.id));
	expect(mismatched.durable.state.events.some(item => item.id === proposed(0).id)).toBe(false);
	expect(mismatched.durable.state.threads[0]?.pendingScopedChoice).toBeUndefined();
	rejected.stop();
});
