import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { actOnResearchOffer, initialState, restoreState } from "./domain";
import { applyResearchOpportunity, researchTargetChanged } from "./research-opportunities";
import {
	type ResearchCandidate,
	researchContext,
	type ResearchInterpretation,
} from "./research-interpreter";
import { entry, harness, opened, unlinked } from "./service.test-fixtures";
import { createProcessor } from "./service";

function proposed(
	state: ConversationPlan.State,
	id = "initial",
	text = "Investigate Jev alternatives.",
	fields: Partial<ResearchCandidate> = {},
) {
	let message = entry(id, text);
	let input = { state: structuredClone(state), message, recent: [] };
	let result: ResearchInterpretation = {
		analysis: {
			messageId: id,
			questionSetVersion: "conversation-research-1",
			modelVersion: "fixture",
			status: "unlinked",
			answers: {},
			policyGate: "candidate",
			latencyMs: 1,
		},
		candidate: {
			source: {
				messageId: id,
				author: { kind: "member", handle: "ana" },
				quote: text,
				start: 0,
				end: text.length,
			},
			context: researchContext(input),
			explicit: true,
			changed: false,
			standalone: true,
			...fields,
		},
	};
	return { input, result, apply: () => applyResearchOpportunity(state, "channel", input, result) };
}

test("a source-backed research offer needs no decision and never starts execution", () => {
	let proposal = proposed(initialState());
	let state = proposal.apply();
	let offer = state.researchOffers![0]!;
	expect(offer.status).toBe("offered");
	expect(offer.workflow?.published).toBe(true);
	expect(offer.action).toBeUndefined();
	expect(state.threads).toEqual([]);
	expect(restoreState(state, [proposal.input.message])).toEqual(state);
	expect(applyResearchOpportunity(state, "channel", proposal.input, proposal.result)).toBe(state);
});

test("ambiguous standalone wording waits for synthesis without publishing a guessed subject", () => {
	let proposal = proposed(initialState(), "short", "Investigate alternatives.", {
		standalone: false,
	});
	expect(proposal.apply().researchOffers![0]!.workflow?.published).toBe(false);
});

test("material discussion refreshes one untouched offer and only moves its presentation source", () => {
	let first = proposed(initialState());
	let state = first.apply();
	let id = state.researchOffers![0]!.id;
	let next = proposed(state, "constraint", "We need self-hosting.", { offerId: id, changed: true });
	state = next.apply();
	expect(state.researchOffers).toHaveLength(1);
	expect(state.researchOffers![0]).toMatchObject({
		id,
		source: { messageId: "initial" },
		workflow: { placementMessageId: "constraint", generation: 1, preparation: "pending" },
	});
	expect(restoreState(state, [first.input.message, next.input.message])).toEqual(state);
});

test("human wording receives optional additions instead of automatic replacement", () => {
	let state = proposed(initialState()).apply();
	let offer = state.researchOffers![0]!;
	offer.workflow!.mode = "human";
	offer.workflow!.editedBy = ["bo"];
	offer.brief = "Compare self-hosted conversation classifiers.";
	let next = proposed(state, "limits", "Also check published rate limits.", {
		offerId: offer.id,
		changed: true,
	}).apply();
	expect(next.researchOffers![0]!.brief).toBe(offer.brief);
	expect(next.researchOffers![0]!.workflow!.additions).toMatchObject([{
		text: "Also check published rate limits.",
		status: "pending",
	}]);
});

test.each([false, true])(
	"dismissed topics require fresh intent or scope: explicit=%s",
	explicit => {
		let state = proposed(initialState()).apply();
		let id = state.researchOffers![0]!.id;
		state = actOnResearchOffer(state, id, {
			id: "dismiss",
			kind: "dismiss",
			actor: { kind: "member", handle: "bo" },
			principalId: "2",
			at: 1,
		});
		let proposal = proposed(state, "again", "Investigate Jev alternatives.", {
			offerId: id,
			explicit,
		});
		let next = proposal.apply();
		expect(next.researchOffers).toHaveLength(explicit ? 2 : 1);
		if (explicit) expect(next.researchOffers![1]!.workflow!.previousOfferId).toBe(id);
	},
);

test("accepted scope is immutable and material new requirements create a follow-up", () => {
	let state = proposed(initialState()).apply();
	let offer = state.researchOffers![0]!;
	offer.status = "accepted";
	offer.action = {
		id: "start",
		kind: "research",
		actor: { kind: "member", handle: "ana" },
		principalId: "1",
		at: 1,
	};
	offer.workflow!.accepted = { brief: offer.brief, revision: 0, executionKey: offer.id };
	expect(proposed(state, "repeat", offer.brief, { offerId: offer.id }).apply()).toBe(state);
	let next = proposed(state, "follow", "Also investigate licensing.", {
		offerId: offer.id,
		changed: true,
	}).apply();
	expect(next.researchOffers![0]).toEqual(offer);
	expect(next.researchOffers![1]!.workflow!.previousOfferId).toBe(offer.id);
});

test("an intervening human edit invalidates an in-flight research judgment", () => {
	let state = proposed(initialState()).apply();
	let offer = state.researchOffers![0]!;
	let proposal = proposed(state, "next", "Investigate pricing.", {
		offerId: offer.id,
		changed: true,
	});
	offer.brief = "New human wording";
	expect(researchTargetChanged(state, proposal.input, proposal.result)).toBe(true);
});

test("one saved message can commit decision and research results independently", async () => {
	let setup = harness(async input => ({
		...unlinked(),
		events: [opened(input.message)],
		analysis: { ...unlinked().analysis, status: "applied" },
	}));
	setup.dependencies.researchInterpret = async input =>
		proposed(input.state, input.message.id, input.message.text).result;
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("mixed", "Consider X, and research its published limits."));
	processor.afterMessage();
	await processor.idle();
	expect(setup.durable.state.threads).toHaveLength(1);
	expect(setup.durable.state.researchOffers).toHaveLength(1);
	expect(setup.durable.state.research!.analysis[0]!.status).toBe("applied");
	expect(setup.durable.pending.some(item => item.kind === "research")).toBe(false);
	processor.stop();
});
