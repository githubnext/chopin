import { expect } from "bun:test";
import { applyEvent } from "./events";
import { beginCandidate } from "./policy-candidate-entry";
import { candidateContext, roleInput } from "./policy-candidate-entry.test-fixtures";
import { captureCandidateRole } from "./policy-candidate-role";
import { cardId, pendingChoice } from "./policy-candidate-scoped.test-fixtures";
import { confidentChoice } from "./policy-initial.test-fixtures";
import { stateWithOption } from "./policy-terminal.test-fixtures";
import type { PolicyInput } from "./policy-types";

// Offline fixtures for archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/policy.ts consequent1370–1431.
// Complete downstream-dependent callbacks remain assigned whole.
export function contributionInput(
	role = "reason",
	quote = "Batched delivery reduces latency.",
): PolicyInput {
	let input = roleInput(role, quote);
	input.state = stateWithOption("Which provider?", "provider", "alpha", "Alpha");
	return input;
}
export function linkContributionCard(input: PolicyInput) {
	input.state = applyEvent(input.state, {
		id: "card-linked",
		type: "card.linked",
		threadId: "provider",
		observedThreadVersion: input.state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		questionnaireId: cardId,
	});
	input.linkedCards = new Map([["provider", {
		cardId,
		options: [{ id: "alpha", label: "Alpha" }],
	}]]);
}
export function qualifiedInput() {
	let input = contributionInput("constraint", "This requires a retry budget.");
	pendingChoice(input);
	input.candidates[0]!.answers.qualifies_pending_settle = { type: "noul", noul: 0.8 };
	input.candidates[0]!.answers.relation = confidentChoice("qualifies");
	return input;
}
export function contributionFrame(input = contributionInput()) {
	let context = candidateContext(input);
	let entry = beginCandidate(context, 0, input.candidates[0]!)!;
	let role = captureCandidateRole(context, entry)!;
	expect(role).toBeDefined();
	return { context, entry, role };
}
