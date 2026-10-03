import type { Chat, ConversationPlan } from "@chopin/protocol";
import { applyInference } from "./domain";
import { beginCandidate } from "./policy-candidate-entry";
import { candidateContext, roleInput } from "./policy-candidate-entry.test-fixtures";
import { captureCandidateRole } from "./policy-candidate-role";
import { message } from "./policy-initial.test-fixtures";
import { stateWithOption } from "./policy-terminal.test-fixtures";
import type { PolicyInput } from "./policy-types";

// Pure domain history for archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// policy.ts factories1092–1107 and early verification/condition1108–1159.
export function verificationInput(): PolicyInput {
	let input = roleInput("reason", "Backups are verified.");
	input.state = stateWithOption("Which provider?", "provider", "alpha", "Alpha");
	let citation = (
		saved: Chat.Entry,
		role: ConversationPlan.SourceRole,
	): ConversationPlan.SourceRef => ({
		messageId: saved.id,
		author: saved.author as ConversationPlan.SourceAuthor,
		quote: saved.text,
		start: 0,
		end: saved.text.length,
		role,
	});
	let historyBase = (id: string) => ({
		id,
		threadId: "provider",
		observedThreadVersion: input.state.threads[0]!.version,
		origin: "classifier" as const,
		actor: { kind: "classifier" as const },
		at: 1000,
	});
	let proposal = message("proposal-message", "Let's use Alpha.", "Jules");
	input.state = applyInference(input.state, {
		...historyBase("proposal-event"),
		type: "settle.suggested",
		source: citation(proposal, "resolution"),
		optionId: "alpha",
	}, proposal);
	let deferred = message("defer-message", "Let's verify backups before choosing.", "Jules");
	input.state = applyInference(input.state, {
		...historyBase("withdrawal-event"),
		type: "stance.changed",
		position: "neutral",
		source: citation(deferred, "withdrawal"),
		optionId: "alpha",
		scopedProposalId: null,
	}, deferred);
	input.state = applyInference(input.state, {
		...historyBase("defer-event"),
		type: "settle.deferred",
		proposalId: "proposal-event",
		source: citation(deferred, "constraint"),
	}, deferred);
	input.first.evidence = { type: "noul", noul: 0.95 };
	return input;
}

export function verificationFrame(input = verificationInput()) {
	let context = candidateContext(input);
	let entry = beginCandidate(context, 0, input.candidates[0]!)!;
	let role = captureCandidateRole(context, entry)!;
	return { context, entry, role };
}
