import { expect } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";
import type { JevAnswer } from "./jev";
import { createPolicyContext, type PolicyContext } from "./policy-context";
import { runInitialTerminals } from "./policy-initial-terminals";
import { runRemainingTerminals } from "./policy-remaining-terminals";
import { confidentChoice, first, follow, inputFor, message } from "./policy-initial.test-fixtures";
import type { Event, PolicyInput, PolicyResult } from "./policy-types";
import { extractQuotes } from "./quotes";

// Preserved from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/pipeline.test.ts.
export function d01RecordedOpening(): PolicyInput {
	let current = message(
		"d01-m1",
		"need to pick an editor before comments get any deeper. what are we comparing?",
		"Nia",
	);
	let quotes = extractQuotes(current.text);
	let firstPass: Record<string, JevAnswer> = {
		...first({
			new_question: 0.88,
			enough_purpose: 0.89,
			c0_owned_unretracted: 0.93,
			c1_owned_unretracted: 0.95,
		}),
		act: {
			type: "choice" as const,
			choice: "question",
			confidence: 0.84,
			probabilities: { question: 0.87, proposal: 0.13 },
		},
		thread_target: {
			type: "choice" as const,
			choice: "new",
			confidence: 0.99,
			probabilities: { new: 1, none: 0 },
		},
	};
	let candidates: PolicyInput["candidates"] = quotes.map((quote, index) => ({
		...quote,
		answers: {
			...follow({ role: index ? "question" : "resolution", thread: "new" }),
			role: {
				type: "choice" as const,
				choice: index ? "question" : "resolution",
				confidence: index ? 0.97 : 0.65,
				probabilities: (index
					? { question: 0.98, none: 0.02 }
					: { resolution: 0.68, question: 0.01, none: 0.31 }) as Record<string, number>,
			},
			thread: {
				type: "choice" as const,
				choice: "new",
				confidence: index ? 0.32 : 0.65,
				probabilities: index ? { new: 0.66, none: 0.34 } : { new: 0.83, none: 0.17 },
			},
			planning_substance: { type: "noul" as const, noul: index ? 0.15 : 0.85 },
		},
	}));
	return {
		channelId: "channel",
		message: current,
		state: initialState(),
		first: firstPass,
		candidates,
	};
}
export function stateWithOption(
	questionText: string,
	threadId: string,
	optionId: string,
	optionText: string,
): ConversationPlan.State {
	return addThreadWithOption(initialState(), threadId, questionText, optionId, optionText);
}
export function addThreadWithOption(
	state: ConversationPlan.State,
	threadId: string,
	questionText: string,
	optionId: string,
	optionText: string,
): ConversationPlan.State {
	let questionMessage = message(`question-${threadId}`, questionText);
	let withQuestion = applyInference(state, {
		id: `open-${threadId}`,
		type: "thread.opened",
		threadId,
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: questionMessage.ts,
		source: {
			messageId: questionMessage.id,
			author: questionMessage.author as ConversationPlan.SourceAuthor,
			quote: questionMessage.text,
			start: 0,
			end: questionMessage.text.length,
			role: "question",
		},
		question: questionMessage.text,
	}, questionMessage);
	let optionMessage = message(`option-${threadId}`, optionText);
	return applyInference(withQuestion, {
		id: `option-${threadId}`,
		type: "option.added",
		threadId,
		observedThreadVersion: withQuestion.threads.find(item => item.id === threadId)!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: optionMessage.ts,
		source: {
			messageId: optionMessage.id,
			author: optionMessage.author as ConversationPlan.SourceAuthor,
			quote: optionMessage.text,
			start: 0,
			end: optionMessage.text.length,
			role: "option",
		},
		contribution: {
			id: optionId,
			text: optionText,
			authoring: "quoted",
			targetId: threadId,
		},
	}, optionMessage);
}

export function remainingPrefix(input: PolicyInput): PolicyResult | undefined {
	let context = createPolicyContext(input);
	let initial = runInitialTerminals(context);
	if (initial) return initial;
	return runRemainingTerminals(context);
}

// The retained callbacks need a terminal result, not a complete-policy implementation.
export function terminalPolicy(input: PolicyInput): PolicyResult {
	let result = remainingPrefix(input);
	expect(result).toBeDefined();
	if (!result) throw new Error("fixture continues beyond remaining policy terminals");
	return result;
}

export function prepareRemaining(input: PolicyInput): PolicyContext {
	let context = createPolicyContext(input);
	expect(runInitialTerminals(context)).toBeUndefined();
	return context;
}

export function declarativeInput(): PolicyInput {
	let input = inputFor("By agent access I mean Copilot or bring-your-own API keys.");
	input.state = stateWithOption(
		"How should we provide agent access?",
		"access",
		"gateway",
		"Use a hosted gateway.",
	);
	input.first.new_option = { type: "noul", noul: 0.95 };
	input.first.thread_target = confidentChoice("access");
	for (let candidate of input.candidates) candidate.answers.thread = confidentChoice("access");
	return input;
}

// Exercise event counts without claiming that the synthetic history is replay-consistent.
export function capEvents(input: PolicyInput, count: number): void {
	input.state.events = Array.from({ length: count }, (_, index): Event => ({
		id: `historical-${index}`,
		type: "thread.opened",
		threadId: `historical-thread-${index}`,
		observedThreadVersion: 0,
		origin: "human",
		actor: { kind: "member", handle: "Mina" },
		at: 999,
		question: "Historical question?",
	}));
}
