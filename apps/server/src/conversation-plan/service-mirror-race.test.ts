import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";
import { applyEvent } from "./events";

import { createProcessor } from "./service";
import { mirroredEvent } from "./card-mirror";
import { deferred, entry, harness, opened, unlinked, until } from "./service.test-fixtures";

// Whole callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
test("in-flight agreement waits for Save and Reopen mirrors, then reinterprets", async () => {
	let cardId = "01K0N4W3B7P27CBAEC7A8C8WEA";
	let optionId = "01K0N4W3B7P27CBAEC7A8C8WEB";
	let seed = entry("seed", "Which auth system?");
	let assent = {
		...entry("assent", "GitHub Apps sounds good."),
		author: { kind: "member" as const, handle: "ben" },
	};
	let state = applyInference(initialState(), opened(seed), seed);
	state = applyEvent(state, {
		id: `card:${cardId}:option:${optionId}`,
		type: "option.added",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "human",
		actor: { kind: "member", handle: "ana" },
		at: 1000,
		contribution: { id: optionId, text: "GitHub Apps", authoring: "human-edited" },
	});
	state = applyEvent(state, {
		id: `card:${cardId}:linked`,
		type: "card.linked",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		questionnaireId: cardId,
	});
	state = applyEvent(state, {
		id: "suggest:seed",
		type: "settle.suggested",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		optionId,
		source: {
			messageId: seed.id,
			author: seed.author as ConversationPlan.SourceAuthor,
			quote: seed.text,
			start: 0,
			end: seed.text.length,
			role: "resolution",
		},
	});
	let held = deferred<ReturnType<typeof unlinked>>();
	let calls = 0;
	let setup = harness(async ({ state: input }) => {
		calls++;
		if (calls > 1) return unlinked();
		return held.promise.then(() => ({
			events: [{
				id: "agree:assent",
				type: "settle.agreed" as const,
				threadId: "thread-a",
				observedThreadVersion: input.threads[0]!.version,
				origin: "classifier" as const,
				actor: { kind: "classifier" as const },
				at: 1000,
				optionId,
				source: {
					messageId: assent.id,
					author: assent.author,
					quote: assent.text,
					start: 0,
					end: assent.text.length,
					role: "support" as const,
				},
			}],
			analysis: {
				questionSetVersion: "conversation-plan-4",
				modelVersion: "fake",
				status: "applied" as const,
				passes: [],
			},
		}));
	});
	setup.plan.chat.entries.push(seed);
	setup.plan.conversationPlan = state;
	setup.plan.records.set(cardId, {
		status: "open",
		history: [],
	} as never);
	let processor = createProcessor(setup.dependencies);
	await processor.accept(assent);
	processor.afterMessage();
	await until(() => calls === 1);
	await setup.dependencies.exclusive(async () => {
		setup.plan.records.set(cardId, {
			status: "reopened",
			history: [{ choices: [optionId], owner: "ana", at: 1000 }],
		} as never);
		setup.plan.pendingCardActions = [{
			id: `card:${cardId}:decided:1`,
			cardId,
			threadId: "thread-a",
			actor: "ana",
			at: 1000,
			kind: "decided",
			generation: 1,
			optionIds: [optionId],
			text: "GitHub Apps",
		}, {
			id: `card:${cardId}:reopened:1`,
			cardId,
			threadId: "thread-a",
			actor: "ana",
			at: 1000,
			kind: "reopened",
			generation: 1,
		}];
		await setup.dependencies.persist();
	});
	let checked = deferred<void>();
	let exclusive = setup.dependencies.exclusive;
	setup.dependencies.exclusive = async action => {
		let result = await exclusive(action);
		checked.resolve();
		return result;
	};
	held.resolve(unlinked());
	await checked.promise;
	expect(setup.plan.conversationPlan.queue[0]?.status).toBe("pending");
	expect(calls).toBe(1);
	expect(setup.errors).toEqual([]);
	expect(setup.plan.conversationPlan.events.some(event => event.type === "settle.agreed"))
		.toBe(false);
	expect(
		setup.durable.pending.filter(effect => effect.kind === "prompt").map(effect => effect.key),
	)
		.toEqual(["prompt:suggest:seed"]);
	let actions = setup.plan.pendingCardActions.slice();
	for (let action of actions) {
		await processor.record(current => {
			let thread = current.threads.find(item => item.id === action.threadId)!;
			return mirroredEvent(thread, action);
		}, action.id);
	}
	await until(() => setup.plan.conversationPlan.queue.length === 0);
	expect(calls).toBe(2);
	expect(setup.plan.conversationPlan.threads[0]?.status).toBe("reopened");
	expect(setup.errors).toEqual([]);
	expect(
		setup.durable.pending.filter(effect => effect.kind === "prompt").map(effect => effect.key),
	)
		.toEqual(["prompt:suggest:seed"]);
});
