import { expect, test } from "bun:test";

import { applyInference, restoreState } from "./domain";
import { applyEvent } from "./events";

import { createProcessor } from "./service";

import { entry } from "./service.test-fixtures";
import {
	addScopedSupport,
	retractScopedSupport,
	saveScopedChoice,
	scopedChoiceSaveInput,
	scopedSaveFixture,
} from "./service-scoped.test-fixtures";

// Whole callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
test("scoped Save retains exact sources from every current supporter", async () => {
	let fixture = scopedSaveFixture(true);
	let jo = addScopedSupport(fixture, "Jo", "save-m8-jo", "save-agreement-jo");
	await fixture.setup.dependencies.persist();
	let processor = createProcessor(fixture.setup.dependencies);
	let result = await saveScopedChoice(processor, scopedChoiceSaveInput(fixture));
	let saved = fixture.setup.durable.state.events.find(item => item.id === result.eventId);
	expect(saved?.type).toBe("scoped-choice.saved");
	if (saved?.type !== "scoped-choice.saved") throw new Error("missing saved choice");
	expect(saved.sources).toEqual([
		fixture.proposal.source,
		fixture.agreement.source,
		jo.agreement.source,
	]);
	expect(fixture.setup.durable.state.events.filter(item => item.type === "scoped-choice.saved"))
		.toHaveLength(1);
	let thread = fixture.setup.plan.conversationPlan.threads[0];
	expect(thread).toMatchObject({
		status: "exploring",
		decisionHistory: [],
	});
	expect(thread?.pendingSettle).toBeUndefined();
	expect(restoreState(fixture.setup.durable.state, fixture.setup.plan.chat.entries).events.at(-1))
		.toEqual(saved);
	processor.stop();
});

test("a proposer withdrawal does not remove a remaining supporter's Save path", async () => {
	let fixture = scopedSaveFixture(true);
	retractScopedSupport(fixture, "Mei", "save-mei-withdraws");
	fixture.setup.dependencies.persist();
	let processor = createProcessor(fixture.setup.dependencies);
	let result = await saveScopedChoice(processor, scopedChoiceSaveInput(fixture));
	let saved = fixture.setup.durable.state.events.find(item => item.id === result.eventId);
	expect(saved?.type).toBe("scoped-choice.saved");
	if (saved?.type !== "scoped-choice.saved") throw new Error("missing saved choice");
	expect(saved.sources).toEqual([fixture.agreement.source]);
	expect(saved.sources).not.toContain(fixture.proposal.source);
	let thread = fixture.setup.plan.conversationPlan.threads[0];
	expect(thread).toMatchObject({
		status: "exploring",
		decisionHistory: [],
	});
	expect(thread?.pendingSettle).toBeUndefined();
	expect(restoreState(fixture.setup.durable.state, fixture.setup.plan.chat.entries).events.at(-1))
		.toEqual(saved);
	processor.stop();
});

test("retracting one supporter keeps the other current supporter in the saved sources", async () => {
	let fixture = scopedSaveFixture(true);
	let jo = addScopedSupport(fixture, "Jo", "save-m8-jo", "save-agreement-jo");
	retractScopedSupport(fixture, "Rob", "save-rob-withdraws");
	fixture.setup.dependencies.persist();
	let processor = createProcessor(fixture.setup.dependencies);
	let result = await saveScopedChoice(processor, scopedChoiceSaveInput(fixture));
	let saved = fixture.setup.durable.state.events.find(item => item.id === result.eventId);
	expect(saved?.type).toBe("scoped-choice.saved");
	if (saved?.type !== "scoped-choice.saved") throw new Error("missing saved choice");
	expect(saved.sources).toEqual([fixture.proposal.source, jo.agreement.source]);
	expect(saved.sources).not.toContain(fixture.agreement.source);
	expect(restoreState(fixture.setup.durable.state, fixture.setup.plan.chat.entries).events.at(-1))
		.toEqual(saved);
	processor.stop();
});

test("scoped Save excludes a support source withdrawn after its agreement", async () => {
	let fixture = scopedSaveFixture(true);
	let { setup } = fixture;
	let state = applyEvent(setup.plan.conversationPlan, {
		id: "save-option-for-retraction",
		type: "option.added",
		threadId: "thread-a",
		observedThreadVersion: setup.plan.conversationPlan.threads[0]!.version,
		origin: "human",
		actor: { kind: "member", handle: "Mei" },
		at: 1003,
		contribution: { id: fixture.optionId, text: "Lexical", authoring: "human-edited" },
	});
	let retraction = entry("save-rob-retracts", "I oppose Lexical now.");
	retraction.author = { kind: "member", handle: "Rob" };
	retraction.ts = 1004;
	state = applyInference(state, {
		id: "save-rob-opposes",
		type: "stance.changed",
		scopedProposalId: fixture.proposal.id,
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: retraction.ts,
		source: {
			messageId: retraction.id,
			author: retraction.author,
			quote: retraction.text,
			start: 0,
			end: retraction.text.length,
			role: "objection",
		},
		optionId: fixture.optionId,
		position: "oppose",
	}, retraction);
	setup.plan.chat.entries.push(retraction);
	setup.plan.conversationPlan = state;
	await setup.dependencies.persist();
	let processor = createProcessor(setup.dependencies);
	let saved = await saveScopedChoice(processor, scopedChoiceSaveInput(fixture));
	let event = setup.durable.state.events.find(item => item.id === saved.eventId);
	expect(event?.type).toBe("scoped-choice.saved");
	if (event?.type !== "scoped-choice.saved") throw new Error("missing saved choice");
	expect(event.agreementId).toBeUndefined();
	expect(event.sources).toEqual([fixture.proposal.source]);
	processor.stop();
});

test("scoped Save keeps an agreement after an unlinked named-option objection", async () => {
	let fixture = scopedSaveFixture(true);
	let { setup } = fixture;
	let state = applyEvent(setup.plan.conversationPlan, {
		id: "save-option-for-unlinked-objection",
		type: "option.added",
		threadId: "thread-a",
		observedThreadVersion: setup.plan.conversationPlan.threads[0]!.version,
		origin: "human",
		actor: { kind: "member", handle: "Mei" },
		at: 1003,
		contribution: { id: fixture.optionId, text: "Lexical", authoring: "human-edited" },
	});
	let objection = entry("save-rob-unlinked-objection", "I oppose Lexical.");
	objection.author = { kind: "member", handle: "Rob" };
	objection.ts = 1004;
	state = applyInference(state, {
		id: "save-rob-unlinked-opposes",
		type: "stance.changed",
		scopedProposalId: null,
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: objection.ts,
		source: {
			messageId: objection.id,
			author: objection.author,
			quote: objection.text,
			start: 0,
			end: objection.text.length,
			role: "objection",
		},
		optionId: fixture.optionId,
		position: "oppose",
	}, objection);
	setup.plan.chat.entries.push(objection);
	setup.plan.conversationPlan = state;
	let processor = createProcessor(setup.dependencies);
	let saved = await saveScopedChoice(processor, scopedChoiceSaveInput(fixture));
	let event = setup.durable.state.events.find(item => item.id === saved.eventId);
	expect(event?.type).toBe("scoped-choice.saved");
	if (event?.type !== "scoped-choice.saved") throw new Error("missing saved choice");
	expect(event.agreementId).toBe(fixture.agreement.id);
	expect(event.sources).toEqual([fixture.proposal.source, fixture.agreement.source]);
	processor.stop();
});
