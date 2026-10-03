import type { ConversationPlan } from "@chopin/protocol";
import type { JevAnswer } from "./jev";
import { applyInference } from "./domain";
import { planEvents, type PolicyInput } from "./policy";
import { extractQuotes } from "./quotes";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import { d01LinkedEditorCard } from "./pipeline-linked-option.test-fixtures";

export function d01SeedScopedChoiceProposal(
	setup: ReturnType<typeof d01LinkedEditorCard>,
	proposalId = "d01-m6-scoped-proposal",
	messageId = "d01-m6",
) {
	let lexicalId = "01M3QAQWN9TYWMFW3D0EYAZY8H";
	let quote = "I'd pick Lexical for the spike;";
	let sourceMessage = message(
		messageId,
		`agreed. ${quote} still want to see how it handles pasted tables.`,
		"Mei",
	);
	let proposal: ConversationPlan.Event = {
		id: proposalId,
		type: "scoped-choice.proposed",
		threadId: setup.threadId,
		observedThreadVersion: setup.state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: sourceMessage.ts,
		source: {
			messageId: sourceMessage.id,
			author: sourceMessage.author as ConversationPlan.SourceAuthor,
			quote,
			start: 8,
			end: 39,
			role: "support",
		},
		cardId: "01M3QAQ8HM8DVYA9E4N28QCQ7T",
		optionId: lexicalId,
		label: "Lexical",
		scope: "spike",
	};
	let state = applyInference(setup.state, proposal, sourceMessage);
	return { ...setup, state, proposal, lexicalId };
}

export function d01RobM7PolicyResult(
	setup: ReturnType<typeof d01LinkedEditorCard>,
	options: {
		state?: ConversationPlan.State;
		author?: string;
		text?: string;
		owned?: number;
		optionId?: string;
		messageId?: string;
	} = {},
) {
	let threadId = setup.threadId;
	let selectedOptionId = options.optionId ?? "01M3QAQWN9TYWMFW3D0EYAZY8H";
	let text = options.text ?? "yep, Lexical for the spike. not a final library call yet.";
	let current = {
		...message(options.messageId ?? "d01-m7", text, options.author ?? "Rob"),
		ts: 1001,
	};
	let quotes = extractQuotes(text);
	let firstPass: Record<string, JevAnswer> = {
		...first({ new_question: 0.14, enough_purpose: 0.93, new_option: 0.33, support: 0.93 }),
		c0_owned_unretracted: { type: "noul", noul: options.owned ?? 0.89 },
		c1_owned_unretracted: { type: "noul", noul: 0.93 },
		act: {
			type: "choice" as const,
			choice: "commitment",
			confidence: 0.4,
			probabilities: {
				question: 0,
				proposal: 0.06,
				evaluation: 0.17,
				commitment: 0.5,
				correction: 0.23,
				other: 0.04,
			},
		},
		thread_target: {
			type: "choice" as const,
			choice: threadId,
			confidence: 0.92,
			probabilities: { [threadId]: 0.95, new: 0, none: 0.05 },
		},
	};
	let optionProbabilities = Object.fromEntries(
		setup.options.map(option => [option.id, option.id === selectedOptionId ? 0.54 : 0]),
	);
	optionProbabilities.none = 0.46;
	let chosenProbabilities = Object.fromEntries(
		setup.options.map(option => [option.id, option.id === selectedOptionId ? 0.63 : 0]),
	);
	chosenProbabilities.none = 0.37;
	let recordedChoices: Record<string, JevAnswer> = {
		option: {
			type: "choice",
			choice: selectedOptionId,
			confidence: 0.46,
			probabilities: optionProbabilities,
		},
		chosen_option: {
			type: "choice",
			choice: selectedOptionId,
			confidence: 0.56,
			probabilities: chosenProbabilities,
		},
	};
	let candidates: PolicyInput["candidates"] = quotes.map((quote, index) => ({
		...quote,
		answers: index === 0
			? {
				...follow({ role: "support", thread: threadId }),
				...recordedChoices,
				role: {
					type: "choice",
					choice: "support",
					confidence: 0.59,
					probabilities: {
						question: 0,
						option: 0.16,
						reason: 0,
						constraint: 0,
						support: 0.63,
						objection: 0,
						resolution: 0.08,
						reopening: 0,
						none: 0.13,
					},
				},
				thread: {
					type: "choice",
					choice: threadId,
					confidence: 0.99,
					probabilities: { [threadId]: 1, new: 0, none: 0 },
				},
				relation: confidentChoice("supports"),
				support: { type: "noul", noul: 0.93 },
				duplicate: { type: "noul", noul: 0.64 },
			}
			: { ...follow({ role: "none", thread: threadId }) },
	}));
	let result = planEvents({
		channelId: "channel",
		message: current,
		state: options.state ?? setup.state,
		linkedCards: setup.linkedCards,
		first: firstPass,
		candidates,
	});
	return { current, quotes, result };
}
