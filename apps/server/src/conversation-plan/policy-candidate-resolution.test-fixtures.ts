import {
	contributionFrame,
	contributionInput,
	linkContributionCard,
} from "./policy-candidate-contribution.test-fixtures";
import { decidedInput } from "./policy-candidate-stance.test-fixtures";
import { confidentChoice } from "./policy-initial.test-fixtures";
import type { PolicyInput } from "./policy-types";

// Offline fixtures for archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/policy.ts consequents1532–1631.
// Original full-policy callbacks remain assigned whole.
export function resolutionInput(materialize = false): PolicyInput {
	let option = materialize ? "beta" : "alpha";
	let input = contributionInput("resolution", `Let's use ${materialize ? "Beta" : "Alpha"}.`);
	linkContributionCard(input);
	let card = input.linkedCards!.get("provider")!;
	input.linkedCards = new Map([["provider", {
		...card,
		options: [...card.options, { id: "beta", label: "Beta" }],
	}]]);
	input.first.explicit_resolution = { type: "noul", noul: 0.8 };
	input.candidates[0]!.answers.explicit_resolution = { type: "noul", noul: 0.85 };
	input.candidates[0]!.answers.option = confidentChoice(option);
	input.candidates[0]!.answers.chosen_option = confidentChoice(option);
	return input;
}
export function reopeningInput() {
	let input = contributionInput("reopening", "Let's revisit the provider choice.");
	input.state = decidedInput().state;
	input.first.reopening = { type: "noul", noul: 0.8 };
	input.candidates[0]!.answers.reopening = { type: "noul", noul: 0.8 };
	return input;
}
export function resolutionFrame(input = resolutionInput()) {
	return contributionFrame(input);
}
export { confidentChoice };
