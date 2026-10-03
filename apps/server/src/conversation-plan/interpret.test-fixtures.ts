import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";
import type { JevQuestion } from "./jev";
import { optionIdFor } from "./policy";
import { message } from "./policy-initial.test-fixtures";
export { message } from "./policy-initial.test-fixtures";
export { stateWithOption } from "./policy-terminal.test-fixtures";

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, pipeline.test.ts.
// Complete callbacks and helpers retained; injected offline transport only.
export let seededOptionId = optionIdFor("channel", "seed-option", 0, 1_000);

export function seeded(): ConversationPlan.State {
	let state = initialState();
	let original = message("m1", "Should we use an optional outline?");
	return applyInference(state, {
		id: "open",
		type: "thread.opened",
		threadId: "thread-a",
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		source: {
			messageId: original.id,
			author: original.author as ConversationPlan.SourceAuthor,
			quote: original.text,
			start: 0,
			end: original.text.length,
			role: "question",
		},
		question: original.text,
	}, original);
}

export function withOption(state: ConversationPlan.State): ConversationPlan.State {
	let proposal = message("seed-option", "Use an optional outline.");
	return applyInference(state, {
		id: "seed-option-event",
		type: "option.added",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0].version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		source: {
			messageId: proposal.id,
			author: proposal.author as ConversationPlan.SourceAuthor,
			quote: proposal.text,
			start: 0,
			end: proposal.text.length,
			role: "option",
		},
		contribution: {
			id: seededOptionId,
			text: proposal.text,
			authoring: "quoted",
			targetId: "thread-a",
		},
	}, proposal);
}

export function settledBy(state: ConversationPlan.State, handle: string): ConversationPlan.State {
	let withFirstOption = withOption(state);
	let proposal = message("settle-proposal", "Let's just go with it.", handle);
	return applyInference(withFirstOption, {
		id: "settle-proposal-event",
		type: "settle.suggested",
		threadId: "thread-a",
		observedThreadVersion: withFirstOption.threads[0].version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: proposal.ts,
		source: {
			messageId: proposal.id,
			author: proposal.author as ConversationPlan.SourceAuthor,
			quote: proposal.text,
			start: 0,
			end: proposal.text.length,
			role: "resolution",
		},
		optionId: seededOptionId,
	}, proposal);
}

export function mockResult(
	questions: Record<string, JevQuestion>,
	overrides: Record<string, string | number>,
): any {
	let answers: Record<string, any> = {};
	let distributions: Record<string, Record<string, number>> = {};
	for (let [key, question] of Object.entries(questions)) {
		if (question.type === "noul") {
			answers[key] = {
				type: "noul",
				noul: typeof overrides[key] === "number"
					? overrides[key]
					: key.endsWith("_owned_unretracted")
					? 0.95
					: 0.05,
			};
		}
		if (question.type === "choice") {
			let choice = typeof overrides[key] === "string" ? overrides[key] : "none";
			if (!(choice in question.criteria)) choice = Object.keys(question.criteria)[0];
			let probabilities = Object.fromEntries(
				Object.keys(question.criteria).map((
					option,
				) => [
					option,
					option === choice ? 0.95 : 0.05 / (Object.keys(question.criteria).length - 1),
				]),
			);
			answers[key] = { type: "choice", choice, confidence: 0.95, probabilities };
		}
		if (question.type === "score") {
			let chosen = typeof overrides[key] === "number" ? Math.round(overrides[key]) : 0;
			let probabilities = Object.fromEntries(
				question.criteria.map((_, i) => [String(i), i === chosen ? 1 : 0]),
			);
			answers[key] = {
				type: "score",
				score: chosen,
				confidence: 1,
				legend: Object.fromEntries(question.criteria.map((label, i) => [String(i), label])),
				probabilities,
			};
		}
		let answer = answers[key];
		distributions[key] = answer.type === "noul"
			? { yes: answer.noul, no: 1 - answer.noul }
			: answer.probabilities;
	}
	return {
		model: "mock-jev",
		answers,
		distributions,
		usage: { input_tokens: 1, output_tokens: 1 },
		latencyMs: 1,
	};
}
