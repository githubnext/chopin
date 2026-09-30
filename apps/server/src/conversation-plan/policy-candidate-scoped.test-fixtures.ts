import { expect } from "bun:test";
import { applyInference } from "./domain";
import { applyEvent } from "./events";
import { beginCandidate } from "./policy-candidate-entry";
import { candidateContext, roleInput } from "./policy-candidate-entry.test-fixtures";
import { captureCandidateRole } from "./policy-candidate-role";
import { runCandidateVerification } from "./policy-candidate-verification";
import { confidentChoice, message } from "./policy-initial.test-fixtures";
import { stateWithOption } from "./policy-terminal.test-fixtures";
import type { Event, PolicyInput } from "./policy-types";

// Pure handler fixtures for archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// policy.ts statements1160–1295. Full downstream callbacks remain assigned.
export let cardId = "01M3QAQ8HM8DVYA9E4N28QCQ7T";
export function scopedInput(assent = false): PolicyInput {
	let input = roleInput(
		"support",
		assent ? "yep, Alpha for a spike." : "I'd pick Alpha for a spike;",
	);
	input.state = stateWithOption("Which provider?", "provider", "alpha", "Alpha");
	input.state = applyEvent(input.state, {
		id: "card-link",
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
		options: [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }],
	}]]);
	input.first.support = { type: "noul", noul: 0.95 };
	if (assent) {
		let saved = message("scoped-proposal-message", "I'd pick Alpha for a spike;", "Jules");
		input.state = applyInference(input.state, {
			id: "scoped-proposal",
			type: "scoped-choice.proposed",
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
				role: "support",
			},
			cardId,
			optionId: "alpha",
			label: "Alpha",
			scope: "spike",
		}, saved);
	}
	return input;
}

export function newChoiceInput(): PolicyInput {
	let input = roleInput("option", "We should use Novel.");
	input.state = stateWithOption("Which provider?", "provider", "alpha", "Alpha");
	input.candidates[0]!.answers.option = confidentChoice("new");
	input.candidates[0]!.answers.chosen_option = confidentChoice("new");
	input.candidates[0]!.answers.support = { type: "noul", noul: 0.95 };
	return input;
}

export function pendingChoice(input: PolicyInput, withdrawn = false): void {
	let saved = message("settle-message", "Let's use Alpha.", "Jules");
	let base = (id: string) => ({
		id,
		threadId: "provider",
		observedThreadVersion: input.state.threads[0]!.version,
		origin: "classifier" as const,
		actor: { kind: "classifier" as const },
		at: 1000,
	});
	let citation = (
		role: "resolution" | "withdrawal",
	): Extract<Event, { type: "settle.suggested" }>["source"] => ({
		messageId: saved.id,
		author: { kind: "member", handle: "Jules" },
		quote: saved.text,
		start: 0,
		end: saved.text.length,
		role,
	});
	input.state = applyInference(input.state, {
		...base("settle"),
		type: "settle.suggested",
		source: citation("resolution"),
		optionId: "alpha",
	}, saved);
	if (withdrawn) {
		saved = message("withdraw-message", "I withdraw that choice.", "Jules");
		input.state = applyInference(input.state, {
			...base("withdraw"),
			type: "stance.changed",
			source: citation("withdrawal"),
			optionId: "alpha",
			scopedProposalId: null,
			position: "neutral",
		}, saved);
	}
}

export function scopedFrame(input = scopedInput()) {
	let context = candidateContext(input);
	let entry = beginCandidate(context, 0, input.candidates[0]!)!;
	let role = captureCandidateRole(context, entry)!;
	let spike = runCandidateVerification(context, entry, role);
	expect(spike).toBeDefined();
	if (!spike) throw new Error("fixture handled before scoped handlers");
	return { context, entry, role, spike };
}
