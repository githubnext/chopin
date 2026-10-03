import { expect, test } from "bun:test";

import { applyInference } from "./domain";

import { createProcessor } from "./service";

import { entry } from "./service.test-fixtures";
import {
	saveScopedChoice,
	scopedChoiceSaveInput,
	scopedSaveFixture,
} from "./service-scoped.test-fixtures";

// Whole callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
test("optionless proposer non-support rejects a stale scoped Save command", async () => {
	let fixture = scopedSaveFixture();
	let { setup } = fixture;
	let opposition = entry("save-mei-optionless", "I don't support that choice anymore.");
	opposition.author = { kind: "member", handle: "Mei" };
	opposition.ts = 1003;
	setup.plan.conversationPlan = applyInference(setup.plan.conversationPlan, {
		id: "save-mei-optionless-opposes",
		type: "stance.changed",
		scopedProposalId: fixture.proposal.id,
		threadId: "thread-a",
		observedThreadVersion: setup.plan.conversationPlan.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: opposition.ts,
		source: {
			messageId: opposition.id,
			author: opposition.author,
			quote: opposition.text,
			start: 0,
			end: opposition.text.length,
			role: "objection",
		},
		position: "oppose",
	}, opposition);
	setup.plan.chat.entries.push(opposition);
	await setup.dependencies.persist();
	let processor = createProcessor(setup.dependencies);
	try {
		await expect(saveScopedChoice(processor, scopedChoiceSaveInput(fixture)))
			.rejects.toThrow();
		expect(setup.durable.state.events.some(event => event.type === "scoped-choice.saved"))
			.toBe(false);
	} finally {
		processor.stop();
	}
});

test("scoped Save is idempotent and rejects stale card snapshots", async () => {
	let fixture = scopedSaveFixture();
	let processor = createProcessor(fixture.setup.dependencies);
	let input = scopedChoiceSaveInput(fixture);
	let first = await saveScopedChoice(processor, input);
	let publicationCount = fixture.setup.publications.length;
	let duplicate = await saveScopedChoice(processor, input);
	expect(duplicate).toEqual(first);
	await expect(saveScopedChoice(processor, { ...input, expectedGeneration: 1 }))
		.rejects.toThrow("scoped choice action ID already used");
	expect(
		fixture.setup.durable.state.events.filter(event =>
			(event as { type: string }).type === "scoped-choice.saved"
		),
	).toHaveLength(1);
	expect(fixture.setup.publications).toHaveLength(publicationCount);
	processor.stop();

	for (let stale of ["generation", "label", "closed card"] as const) {
		let next = scopedSaveFixture();
		let record = next.setup.plan.records.get(next.cardId) as {
			status: string;
			history: unknown[];
			definition: { questions: Array<{ options: Array<{ id: string; label: string }> }> };
		};
		let staleInput = scopedChoiceSaveInput(next, `stale-${stale}`);
		if (stale === "generation") staleInput.expectedGeneration = 1;
		if (stale === "label") record.definition.questions[0]!.options[0]!.label = "Tiptap";
		if (stale === "closed card") record.status = "decided";
		let staleProcessor = createProcessor(next.setup.dependencies);
		await expect(saveScopedChoice(staleProcessor, staleInput)).rejects.toThrow();
		expect(
			next.setup.plan.conversationPlan.events.some(event =>
				(event as { type: string }).type === "scoped-choice.saved"
			),
		).toBe(false);
		expect(next.setup.publications).toEqual([]);
		staleProcessor.stop();
	}
});

test("a failed scoped Save commit publishes no saved choice", async () => {
	let fixture = scopedSaveFixture();
	let processor = createProcessor(fixture.setup.dependencies);
	fixture.setup.fail();
	await expect(saveScopedChoice(processor, scopedChoiceSaveInput(fixture)))
		.rejects.toThrow("storage failed");
	expect(
		fixture.setup.plan.conversationPlan.events.some(event =>
			(event as { type: string }).type === "scoped-choice.saved"
		),
	).toBe(false);
	expect(fixture.setup.publications).toEqual([]);
	processor.stop();
});
