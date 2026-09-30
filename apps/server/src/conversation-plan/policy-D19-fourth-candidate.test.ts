import { expect, test } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";
import type { JevAnswer } from "./jev";
import { planEvents } from "./policy";
import { extractQuotes } from "./quotes";

let text =
	"For human sign-in, the options are GitHub OAuth or email magic links. Separately, for the hosted agent’s repository credentials, we could pass each user’s GitHub token or use a GitHub App installation token. Those are two different calls.";
let current: Chat.Entry = {
	id: "D19-m2",
	text,
	author: { kind: "member", handle: "Omar" },
	ts: 1_001,
};
let threadId = "human-sign-in";

function choice(value: string): JevAnswer {
	return {
		type: "choice",
		choice: value,
		confidence: 0.95,
		probabilities: { [value]: 0.95, none: 0.05 },
	};
}

function openThread(): ConversationPlan.State {
	let opening: Chat.Entry = {
		id: "m1-human",
		text: "How should people sign in?",
		author: { kind: "member", handle: "Leah" },
		ts: 1_000,
	};
	let state = applyInference(initialState(), {
		id: "open-human-sign-in",
		type: "thread.opened",
		threadId,
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: opening.ts,
		source: {
			messageId: opening.id,
			author: opening.author as ConversationPlan.SourceAuthor,
			quote: opening.text,
			start: 0,
			end: opening.text.length,
			role: "question",
		},
		question: opening.text,
	}, opening);
	let agentQuestion: Chat.Entry = {
		id: "m1-agent",
		text: "How should the hosted agent get repository credentials?",
		author: { kind: "member", handle: "Leah" },
		ts: 1_000,
	};
	return applyInference(state, {
		id: "open-agent-credentials",
		type: "thread.opened",
		threadId: "agent-credentials",
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: agentQuestion.ts,
		source: {
			messageId: agentQuestion.id,
			author: agentQuestion.author as ConversationPlan.SourceAuthor,
			quote: agentQuestion.text,
			start: 0,
			end: agentQuestion.text.length,
			role: "question",
		},
		question: agentQuestion.text,
	}, agentQuestion);
}

test("policy accepts the fourth D19 option candidate instead of truncating at three", () => {
	let quotes = extractQuotes(text);
	let first = {
		new_question: { type: "noul" as const, noul: 0.05 },
		new_option: { type: "noul" as const, noul: 0.95 },
		explicit_resolution: { type: "noul" as const, noul: 0.05 },
		act: choice("proposal"),
		thread_target: choice(threadId),
		...Object.fromEntries(quotes.map((_, index) => [
			`c${index}_owned_unretracted`,
			{ type: "noul" as const, noul: 0.95 },
		])),
	};
	let candidates = quotes.map((quote, index) => ({
		...quote,
		answers: {
			role: choice("option"),
			thread: choice(index < 2 ? threadId : "agent-credentials"),
			option: choice("new"),
			chosen_option: choice("new"),
			new_option: { type: "noul" as const, noul: 0.95 },
			planning_substance: { type: "noul" as const, noul: 0.95 },
			duplicate: { type: "noul" as const, noul: 0.05 },
			support: { type: "noul" as const, noul: 0.05 },
		},
	}));
	let planned = planEvents({
		channelId: "channel",
		message: current,
		state: openThread(),
		first,
		candidates,
	});

	expect(
		planned.events.flatMap(event =>
			event.type === "option.added"
				? [{
					quote: event.source?.quote,
					start: event.source?.start,
					end: event.source?.end,
				}]
				: []
		),
	).toEqual(quotes);
});
