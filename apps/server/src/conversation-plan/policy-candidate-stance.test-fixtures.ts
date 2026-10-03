import { applyEvent } from "./events";
import { applyInference } from "./domain";
import {
	contributionFrame,
	contributionInput,
	linkContributionCard,
} from "./policy-candidate-contribution.test-fixtures";
import { scopedInput } from "./policy-candidate-scoped.test-fixtures";
import { confidentChoice, message } from "./policy-initial.test-fixtures";
import type { PolicyInput } from "./policy-types";

// Offline fixtures for archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/policy.ts consequent1433–1530.
// Original complete downstream callbacks remain assigned whole.
export function stanceInput(
	role = "support",
	quote = role === "support" ? "I support Alpha." : "I oppose Alpha.",
): PolicyInput {
	let input = contributionInput(role, quote);
	linkContributionCard(input);
	return input;
}
export function decidedInput(probability = 0.68) {
	let input = stanceInput("objection");
	input.state = applyEvent(input.state, {
		id: "decide-provider",
		type: "decision.recorded",
		threadId: "provider",
		observedThreadVersion: input.state.threads[0]!.version,
		origin: "human",
		actor: { kind: "member", handle: "Jules" },
		at: 1000,
		explicit: true,
		text: "Use Alpha.",
		optionId: "alpha",
	});
	input.candidates[0]!.answers.material_objection = { type: "noul", noul: probability };
	return input;
}
export function scopedStanceInput(participant = "Jules", agreed = false, role = "objection") {
	let input = stanceInput(role), saved = scopedInput(true);
	input.state = saved.state;
	input.linkedCards = saved.linkedCards;
	input.message.author = { kind: "member", handle: participant };
	if (agreed) {
		let assent = message("scoped-assent", "yep, Alpha for a spike.", "Mina");
		input.state = applyInference(input.state, {
			id: "scoped-assent",
			type: "scoped-choice.agreed",
			threadId: "provider",
			observedThreadVersion: input.state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 1000,
			source: {
				messageId: assent.id,
				author: { kind: "member", handle: "Mina" },
				quote: assent.text,
				start: 0,
				end: assent.text.length,
				role: "support",
			},
			proposalId: "scoped-proposal",
			cardId: input.state.threads[0]!.questionnaireId!,
			optionId: "alpha",
			label: "Alpha",
			scope: "spike",
		}, assent);
	}
	return input;
}
export function rawChoice(id: string, probability = 0.4) {
	return {
		type: "choice" as const,
		choice: id,
		confidence: probability,
		probabilities: { [id]: probability, none: 0.35, other: 0.25 },
	};
}
export function stanceFrame(input = stanceInput()) {
	return contributionFrame(input);
}
export { confidentChoice };

export function withdrawScopedAgreement(input: PolicyInput) {
	let saved = message("scoped-withdrawal", "I withdraw my spike support.", "Mina");
	input.state = applyInference(input.state, {
		id: "scoped-withdrawal",
		type: "stance.changed",
		threadId: "provider",
		observedThreadVersion: input.state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		source: {
			messageId: saved.id,
			author: { kind: "member", handle: "Mina" },
			quote: saved.text,
			start: 0,
			end: saved.text.length,
			role: "withdrawal",
		},
		optionId: "alpha",
		scopedProposalId: "scoped-proposal",
		position: "neutral",
	}, saved);
}
