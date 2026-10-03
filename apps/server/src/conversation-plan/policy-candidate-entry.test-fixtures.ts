import { prepareCandidateRun } from "./policy-candidate-setup";
import { choiceInput, groupInput, prepareCandidateContext } from "./policy-candidate.test-fixtures";
import { confidentChoice, follow } from "./policy-initial.test-fixtures";
import type { PolicyInput } from "./policy-types";

// Offline entry/role fixtures for archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// policy.ts statements878–1091. Downstream full-policy callbacks remain assigned.
export function candidateContext(input: PolicyInput = groupInput()) {
	let context = prepareCandidateContext(input);
	prepareCandidateRun(context);
	return context;
}

export function roleInput(role = "reason", quote = "This reduces latency."): PolicyInput {
	let input = choiceInput(["alpha"]);
	let span = groupInput([quote]);
	input.message = span.message;
	input.first.significance = {
		type: "score",
		score: 2,
		confidence: 0.95,
		legend: { "0": "chatter", "1": "minor", "2": "useful" },
		probabilities: { "2": 1 },
	};
	input.first.reason = { type: "noul", noul: 0.95 };
	input.candidates[0] = {
		...span.candidates[0]!,
		answers: {
			...follow({ role, thread: "provider" }),
			option: confidentChoice("alpha"),
			chosen_option: confidentChoice("alpha"),
			relation: confidentChoice("supports"),
			planning_substance: { type: "noul", noul: 0.95 },
			duplicate: { type: "noul", noul: 0.05 },
		},
	};
	return input;
}
