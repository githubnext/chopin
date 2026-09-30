import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { JevAnswer } from "./jev";
import type { Event, PolicyInput, PolicyResult, State } from "./policy-types";
import { directAlternativeQuotes, type QuoteCandidate } from "./quotes";
import { assertQuoteBudget } from "./quote-budget";

export type DirectFacts = {
	optionLabels: string[];
	directAlternatives: ReturnType<typeof directAlternativeQuotes>;
	exactDirectAlternatives: boolean;
	questionKey: string;
	matchingThreads: ConversationPlan.Thread[];
	directBounds: boolean;
	topicThreeWay: boolean;
};
export type PolicyContext = {
	input: PolicyInput;
	channelId: string;
	message: Chat.Entry;
	first: Record<string, JevAnswer>;
	events: Event[];
	reviews: PolicyResult["candidates"];
	outcomes: PolicyResult["outcomes"];
	working: State;
	selectedTarget: string | undefined;
	facts?: DirectFacts;
	directQuestion?: boolean;
	quotedOption?: (
		candidate: QuoteCandidate,
		index: number,
		threadId: string,
		state: State,
	) => Event;
};

/** Initialize before running terminals; quote budget is checked before any other input reads. */
export function createPolicyContext(input: PolicyInput): PolicyContext {
	assertQuoteBudget(input.candidates);
	let { channelId, message, first } = input;
	let events: Event[] = [];
	let reviews: PolicyResult["candidates"] = [];
	let outcomes: PolicyResult["outcomes"] = [];
	let working = input.state;
	let selectedTarget: string | undefined = undefined;

	return { input, channelId, message, first, events, reviews, outcomes, working, selectedTarget };
}

/** Called only after the runner has rejected ineligible messages. */
export function directFacts(context: PolicyContext): DirectFacts {
	let { input, message } = context;
	// A new question expressed as several options has no existing thread ID for pass 2 to target.
	// Keep the question and each option tied to exact spans of this one bounded message.
	let optionLabels = input.candidates.map(candidate =>
		candidate.quote.trim().replace(/\s+/g, " ").toLowerCase()
	);
	let directAlternatives = directAlternativeQuotes(message.text);
	let exactDirectAlternatives = directAlternatives.length === input.candidates.length
		&& directAlternatives.length >= 2
		&& directAlternatives.every((quote, index) =>
			quote.start === input.candidates[index]?.start
			&& quote.end === input.candidates[index]?.end
			&& quote.quote === input.candidates[index]?.quote
		);
	let questionKey = message.text.trim().replace(/\s+/g, " ").toLowerCase();
	let matchingThreads = input.state.threads.filter(thread =>
		thread.status !== "discarded"
		&& thread.question.trim().replace(/\s+/g, " ").toLowerCase() === questionKey
	);
	let directBounds = message.text.length <= 500
		&& new Set(optionLabels).size === input.candidates.length
		&& input.candidates.every(candidate =>
			candidate.quote.length <= 500 && !!candidate.quote.trim()
			&& message.text.slice(candidate.start, candidate.end) === candidate.quote
		);
	let topicThreeWay = /\bwhat sends\b[^?]{1,160}\?\s+our\b[^,]{1,160},/i
		.test(message.text);

	return {
		optionLabels,
		directAlternatives,
		exactDirectAlternatives,
		questionKey,
		matchingThreads,
		directBounds,
		topicThreeWay,
	};
}
