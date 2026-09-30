import { compoundAttribution, compoundOpenings, topicCorroboration } from "./policy-compound";
import { directFacts, type PolicyContext } from "./policy-context";
import { createQuotedOption, directRecovery } from "./policy-direct-recovery";
import type { PolicyResult } from "./policy-types";

/** Requires createPolicyContext first. Undefined continues beyond these four terminal checks. */
export function runInitialTerminals(context: PolicyContext): PolicyResult | undefined {
	let { message, events, reviews, outcomes } = context;
	if (message.streaming || !message.text || message.author.kind === "system") {
		return { events, candidates: reviews, outcomes, policyGate: "ineligible message" };
	}

	let facts = directFacts(context);
	context.facts = facts;
	let result = topicCorroboration(context, facts);
	if (result) return result;
	let quotedOption = createQuotedOption(context);
	context.quotedOption = quotedOption;
	result = compoundAttribution(context);
	if (result) return result;
	result = compoundOpenings(context);
	if (result) return result;
	return directRecovery(context, facts, quotedOption);
}
