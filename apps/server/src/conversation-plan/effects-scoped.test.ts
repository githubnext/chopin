import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { effectsFor } from "./effects";
import {
	m7MessageText,
	scopedAgreement,
	scopedProposal,
	scopedState,
} from "./effects.test-fixtures";

// Whole callbacks from archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.test.ts.
test("a scoped choice proposal creates a keyed inline Save notice without a final prompt", () => {
	let proposal = scopedProposal();
	let effects = effectsFor([proposal], scopedState(proposal));
	expect(effects).toHaveLength(1);
	expect(effects[0]).toMatchObject({
		key: `scoped-choice:${proposal.id}:proposal`,
		kind: "scoped-choice",
		threadId: proposal.threadId,
		proposalId: proposal.id,
		cardId: proposal.cardId,
		optionId: proposal.optionId,
		label: proposal.label,
		scope: proposal.scope,
		sources: [proposal.source],
	});
	expect(effects.some(item => item.kind === "prompt")).toBe(false);
});

test("a scoped agreement refreshes the same proposal notice with both exact member sources", () => {
	let proposal = scopedProposal();
	let agreement = scopedAgreement(proposal);
	expect(agreement.source.quote).toBe(
		m7MessageText.slice(agreement.source.start, agreement.source.end),
	);
	let effects = effectsFor([agreement], scopedState(proposal, agreement));
	expect(effects).toHaveLength(1);
	expect(effects[0]).toMatchObject({
		key: `scoped-choice:${proposal.id}:agreement:${agreement.id}`,
		kind: "scoped-choice",
		threadId: proposal.threadId,
		proposalId: proposal.id,
		cardId: proposal.cardId,
		optionId: proposal.optionId,
		label: proposal.label,
		scope: proposal.scope,
		sources: [proposal.source, agreement.source],
	});
	expect(effects.some(item => item.kind === "prompt")).toBe(false);
});

test("saving a scoped choice does not create another active Save notice", () => {
	let proposal = scopedProposal();
	let saved: ConversationPlan.Event = {
		id: "saved-m6",
		type: "scoped-choice.saved",
		threadId: proposal.threadId,
		observedThreadVersion: 2,
		origin: "human",
		actor: { kind: "member", handle: "ana" },
		at: 8,
		proposalId: proposal.id,
		cardId: proposal.cardId,
		optionId: proposal.optionId,
		label: proposal.label,
		scope: proposal.scope,
		sources: [proposal.source],
		expectedGeneration: 0,
	};
	let state = scopedState(proposal, saved);
	state.threads[0]!.pendingScopedChoice = undefined;
	let effects = effectsFor([saved], state);
	expect(effects.map(item => String(item.kind))).not.toContain("scoped-choice");
	expect(effects.some(item => item.kind === "prompt")).toBe(false);
});
