import { expect, test } from "bun:test";

import { restoreState } from "./domain";

import { createProcessor } from "./service";

import {
	saveScopedChoice,
	scopedChoiceSaveInput,
	scopedSaveFixture,
} from "./service-scoped.test-fixtures";

// Whole callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
test("a member can Save an m6-only scoped choice without answering the card", async () => {
	let fixture = scopedSaveFixture();
	let { setup } = fixture;
	let processor = createProcessor(setup.dependencies);
	let input = scopedChoiceSaveInput(fixture);
	let result = await saveScopedChoice(processor, input);
	let saved = setup.durable.state.events.at(-1);
	let savedEvent = saved as unknown as {
		type: string;
		proposalId: string;
		agreementId?: string;
	} | undefined;

	expect(result.eventId).toBe("human:Rob:save-spike-choice");
	expect(savedEvent).toMatchObject({
		type: "scoped-choice.saved",
		origin: "human",
		actor: { kind: "member", handle: "Rob" },
		proposalId: fixture.proposal.id,
		cardId: fixture.cardId,
		optionId: fixture.optionId,
		label: "Lexical",
		scope: "spike",
	});
	expect(savedEvent?.agreementId).toBeUndefined();
	let proposalEvent = setup.durable.state.events.find(event => event.id === savedEvent?.proposalId);
	expect(proposalEvent && "source" in proposalEvent ? proposalEvent.source : undefined)
		.toEqual(fixture.proposal.source);
	let savedThread = setup.plan.conversationPlan.threads[0]!;
	expect(savedThread).toMatchObject({
		status: "exploring",
		pendingScopedChoice: { proposalId: fixture.proposal.id, optionId: fixture.optionId },
		decisionHistory: [],
	});
	expect(savedThread.pendingSettle).toBeUndefined();
	expect(savedThread.decision).toBeUndefined();
	expect(setup.plan.records.get(fixture.cardId)).toMatchObject({ status: "open", history: [] });
	expect(setup.publications.at(-1)?.events.at(-1)).toMatchObject({
		type: "scoped-choice.saved",
		id: result.eventId,
	});
	expect(restoreState(setup.durable.state, setup.plan.chat.entries).events.at(-1))
		.toEqual(saved);
	let altered = structuredClone(setup.durable.state);
	let alteredSave = altered.events.at(-1);
	if (alteredSave?.type !== "scoped-choice.saved") throw new Error("missing saved choice");
	alteredSave.sources[0].quote = "I would pick another editor for the spike.";
	expect(() => restoreState(altered, setup.plan.chat.entries)).toThrow();
	processor.stop();
});

test("Save optionally links Rob's m7 agreement as a second exact source", async () => {
	let fixture = scopedSaveFixture(true);
	let processor = createProcessor(fixture.setup.dependencies);
	let result = await saveScopedChoice(processor, scopedChoiceSaveInput(fixture));
	let saved = fixture.setup.durable.state.events.find(event => event.id === result.eventId);
	let savedEvent = saved as unknown as {
		type: string;
		proposalId: string;
		agreementId?: string;
	} | undefined;

	expect(savedEvent).toMatchObject({
		type: "scoped-choice.saved",
		proposalId: fixture.proposal.id,
		agreementId: fixture.agreement.id,
	});
	let proposalEvent = fixture.setup.durable.state.events.find(event =>
		event.id === savedEvent?.proposalId
	);
	let agreementEvent = fixture.setup.durable.state.events.find(event =>
		event.id === savedEvent?.agreementId
	);
	expect(proposalEvent && "source" in proposalEvent ? proposalEvent.source : undefined)
		.toEqual(fixture.proposal.source);
	expect(agreementEvent && "source" in agreementEvent ? agreementEvent.source : undefined)
		.toEqual(fixture.agreement.source);
	expect(fixture.setup.plan.records.get(fixture.cardId)).toMatchObject({
		status: "open",
		history: [],
	});
	expect(restoreState(fixture.setup.durable.state, fixture.setup.plan.chat.entries).events.at(-1))
		.toEqual(saved);
	processor.stop();
});
