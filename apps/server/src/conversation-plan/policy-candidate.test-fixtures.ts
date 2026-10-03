import { expect } from "bun:test";
import { initialState } from "./domain";
import { createPolicyContext, type PolicyContext } from "./policy-context";
import { runInitialTerminals } from "./policy-initial-terminals";
import { runRemainingTerminals } from "./policy-remaining-terminals";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import { addThreadWithOption, stateWithOption } from "./policy-terminal.test-fixtures";
import type { PolicyInput } from "./policy-types";

// Setup-only fixtures for archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// policy.ts statements800–876. Original full-policy callbacks remain deferred whole.
export function groupInput(quotes: readonly string[] = ["Alpha", "Beta", "Gamma"]): PolicyInput {
	let text = quotes.join(" ");
	let offset = 0;
	return {
		channelId: "channel",
		message: message("candidate-setup", text),
		state: initialState(),
		first: {
			...first({ new_question: 0.95, c3_owned_unretracted: 0.95 }),
			act: confidentChoice("question"),
			thread_target: confidentChoice("new"),
		},
		candidates: quotes.map(quote => {
			let start = offset;
			offset += quote.length + 1;
			return {
				start,
				end: start + quote.length,
				quote,
				answers: { ...follow({ role: "option", thread: "new" }) },
			};
		}),
	};
}

export function choiceInput(ids: readonly string[] = ["alpha", "beta"]): PolicyInput {
	let input = groupInput(ids.map(id => `We should use ${id}.`));
	input.state = stateWithOption("Which provider?", "provider", "alpha", "Alpha");
	input.state = addThreadWithOption(input.state, "other", "Which other provider?", "beta", "Beta");
	let other = input.state.threads.find(thread => thread.id === "other")!;
	input.state.threads[0]!.contributions.push({ ...other.contributions[0]!, id: "beta" });
	input.first.act = confidentChoice("proposal");
	input.first.thread_target = confidentChoice("provider");
	input.first.new_option = { type: "noul", noul: 0.95 };
	for (let [index, candidate] of input.candidates.entries()) {
		candidate.answers = {
			...follow({ role: "support", thread: "provider" }),
			chosen_option: confidentChoice(ids[index]!),
			option: confidentChoice(ids[index]!),
			new_option: { type: "noul", noul: 0.95 },
			planning_substance: { type: "noul", noul: 0.95 },
			duplicate: { type: "noul", noul: 0.05 },
		};
	}
	return input;
}

export function prepareCandidateContext(input: PolicyInput): PolicyContext {
	let context = createPolicyContext(input);
	expect(runInitialTerminals(context)).toBeUndefined();
	expect(runRemainingTerminals(context)).toBeUndefined();
	return context;
}
