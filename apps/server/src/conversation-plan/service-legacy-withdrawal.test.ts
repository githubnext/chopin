import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState, restoreState } from "./domain";
import { applyEvent } from "./events";

import { createProcessor } from "./service";

import { entry, harness, opened, until } from "./service.test-fixtures";

// Whole callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
test("a legacy accepted withdrawal recovers its missing advisory clear and prompt work", async () => {
	let setup = harness();
	let question = entry("question", "Which auth system?");
	let proposal = entry("m5", "Let's settle on GitHub Apps");
	let withdrawal = entry("m7", "I no longer support GitHub Apps");
	setup.plan.chat.entries.push(question, proposal, withdrawal);
	let state = applyInference(initialState(), opened(question), question);
	let optionId = "01K0N4W3B7P27CBAEC7A8C8WEA";
	state = applyEvent(state, {
		id: "option",
		type: "option.added",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "human",
		actor: { kind: "member", handle: "ana" },
		at: 1000,
		contribution: { id: optionId, text: "GitHub Apps", authoring: "human-edited" },
	});
	state = applyInference(state, {
		id: "proposed",
		type: "settle.suggested",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: proposal.ts,
		optionId,
		source: {
			messageId: proposal.id,
			author: proposal.author as ConversationPlan.SourceAuthor,
			quote: proposal.text,
			start: 0,
			end: proposal.text.length,
			role: "resolution",
		},
	}, proposal);
	state = applyInference(state, {
		id: "withdrawn",
		type: "stance.changed",
		scopedProposalId: null,
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: withdrawal.ts,
		optionId,
		position: "oppose",
		source: {
			messageId: withdrawal.id,
			author: withdrawal.author as ConversationPlan.SourceAuthor,
			quote: withdrawal.text,
			start: 0,
			end: withdrawal.text.length,
			role: "objection",
		},
	}, withdrawal);
	expect(restoreState(state, setup.plan.chat.entries)).toEqual(state);
	setup.plan.conversationPlan = state;
	let processor = createProcessor(setup.dependencies);
	setup.fail();
	processor.wake();
	await until(() => setup.errors.length === 1);
	expect(setup.plan.conversationPlanPendingEffects).toEqual([]);
	expect(setup.publications).toEqual([]);
	processor.wake();
	await until(() => setup.durable.pending.some(effect => effect.key === "prompt:withdrawn"));
	expect(setup.durable.pending).toMatchObject([
		{ kind: "insert-card" },
		{ key: "suggest:withdrawn", kind: "suggest", messageIds: [] },
		{ key: "prompt:withdrawn", kind: "prompt", sourceMessageIds: [] },
	]);
	expect(setup.publications).toEqual([]);
	let recovered = structuredClone(setup.durable.pending);
	processor.stop();
	let resumed = createProcessor(setup.dependencies);
	resumed.wake();
	await Bun.sleep(10);
	expect(setup.durable.pending).toEqual(recovered);
	resumed.stop();
});
