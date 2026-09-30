import { expect } from "bun:test";
import { applyInference } from "./domain";
import { beginCandidate } from "./policy-candidate-entry";
import { candidateContext, roleInput } from "./policy-candidate-entry.test-fixtures";
import { captureCandidateRole } from "./policy-candidate-role";
import { pendingChoice } from "./policy-candidate-scoped.test-fixtures";
import { confidentChoice, message } from "./policy-initial.test-fixtures";
import { stateWithOption } from "./policy-terminal.test-fixtures";
import type { PolicyInput } from "./policy-types";

// Offline fixtures for archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/policy.ts consequents1298–1368.
// Complete downstream-dependent callbacks remain assigned to the full policy.
export function ordinaryInput(
	role: "withdrawal" | "none" | "question" = "withdrawal",
): PolicyInput {
	let input = roleInput(
		role,
		role === "withdrawal"
			? "I withdraw that choice."
			: role === "none"
			? "I agree with that choice."
			: "Should retries survive a restart?",
	);
	input.state = stateWithOption("Which provider?", "provider", "alpha", "Alpha");
	input.first.new_question = { type: "noul", noul: 0.6 };
	input.first.withdrawal = { type: "noul", noul: 0.95 };
	input.candidates[0]!.answers.withdraws_pending_settle = { type: "noul", noul: 0.8 };
	input.candidates[0]!.answers.agrees_with_settle = { type: "noul", noul: 0.7 };
	if (role !== "question") {
		pendingChoice(input);
		if (role === "withdrawal") input.message.author = { kind: "member", handle: "Jules" };
	} else {
		input.first.thread_target = confidentChoice("new");
		input.candidates[0]!.answers.thread = confidentChoice("new");
	}
	return input;
}
export function ordinaryFrame(input = ordinaryInput()) {
	let context = candidateContext(input);
	let entry = beginCandidate(context, 0, input.candidates[0]!)!;
	let role = captureCandidateRole(context, entry)!;
	expect(role).toBeDefined();
	return { context, entry, role };
}
export function withdrawCurrent(input: PolicyInput) {
	let saved = message("later-withdrawal", "I withdraw that choice.", "Jules");
	return applyInference(input.state, {
		id: "later-withdrawal",
		type: "stance.changed",
		threadId: "provider",
		observedThreadVersion: input.state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		source: {
			messageId: saved.id,
			author: { kind: "member", handle: "Jules" },
			quote: saved.text,
			start: 0,
			end: saved.text.length,
			role: "withdrawal",
		},
		optionId: "alpha",
		scopedProposalId: null,
		position: "neutral",
	}, saved);
}
