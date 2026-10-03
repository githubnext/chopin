import { expect } from "bun:test";
import { applyInference } from "./domain";
import {
	contributionFrame,
	contributionInput,
} from "./policy-candidate-contribution.test-fixtures";
import { runContribution } from "./policy-candidate-contribution";
import { runStance } from "./policy-candidate-stance";
import { stanceInput } from "./policy-candidate-stance.test-fixtures";
import { pendingChoice } from "./policy-candidate-scoped.test-fixtures";
import { message } from "./policy-initial.test-fixtures";
import type { Event, PolicyInput } from "./policy-types";

// Offline application fixtures for archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// policy.ts whole try/catch1634–1726. Full policy callbacks remain assigned whole.
export function supportInput(
	participants: string[] = ["Jules"],
	pending = false,
	quote = "I support Alpha.",
) {
	let input = stanceInput("support", quote);
	for (let [index, handle] of participants.entries()) {
		let saved = message(`prior-support-${index}`, "I support Alpha.", handle);
		input.state = applyInference(
			input.state,
			stanceEvent(input, saved, `prior-support-${index}`, "support"),
			saved,
		);
	}
	if (pending) pendingChoice(input);
	return input;
}
export function stanceEvent(
	input: PolicyInput,
	saved: PolicyInput["message"],
	id: string,
	position: "support" | "neutral",
): Extract<Event, { type: "stance.changed" }> {
	if (saved.author.kind !== "member") throw new Error("fixture requires a member source");
	return {
		id,
		type: "stance.changed",
		threadId: "provider",
		observedThreadVersion: input.state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		source: {
			messageId: saved.id,
			author: saved.author,
			quote: saved.text,
			start: 0,
			end: saved.text.length,
			role: position === "neutral" ? "withdrawal" : "support",
		},
		optionId: "alpha",
		scopedProposalId: null,
		position,
	};
}
export function deferralInput(
	handle = "Jules",
	sameMessage = true,
	quote = "Let's verify backups before choosing.",
) {
	let input = contributionInput("constraint", quote);
	input.message.author = { kind: "member", handle };
	pendingChoice(input);
	let saved = sameMessage
		? input.message
		: message("older-withdrawal", "I withdraw that choice.", handle);
	let neutral = stanceEvent(input, saved, "same-batch-neutral", "neutral");
	input.state = applyInference(input.state, neutral, saved);
	return { input, neutral };
}
export function applicationFrame(input = supportInput(), batch: Event[] = []) {
	let result = contributionFrame(input);
	result.context.events.push(...batch);
	let proposed = result.role.role === "constraint"
		? runContribution(result.context, result.entry, result.role)?.proposed
		: runStance(result.context, result.entry, result.role)?.proposed;
	expect(proposed).toBeDefined();
	if (!proposed) {
		throw new Error("application requires a definite proposal after the original guard");
	}
	return { ...result, proposed };
}
export function batchEvents(event: Event, count: number): Event[] {
	// Synthetic publication-batch boundary; these entries do not claim a replay history.
	return Array.from({ length: count }, (_, index) => ({ ...event, id: `batch-${index}` }));
}
