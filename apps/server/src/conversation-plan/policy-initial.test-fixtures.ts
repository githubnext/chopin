import { expect } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";
import { createPolicyContext } from "./policy-context";
import { runInitialTerminals } from "./policy-initial-terminals";
import type { PolicyInput, PolicyResult } from "./policy-types";
import { extractQuotes } from "./quotes";

// Preserved from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/pipeline.test.ts.
export let confidentChoice = (choice: string): any => ({
	type: "choice",
	choice,
	confidence: 0.95,
	probabilities: { [choice]: 0.95, ...(choice === "none" ? { other: 0.05 } : { none: 0.05 }) },
});
export let member = (handle: string): Extract<Chat.Author, { kind: "member" }> => ({
	kind: "member",
	handle,
});
export let message = (id: string, text: string, handle = "Mina"): Chat.Entry => ({
	id,
	text,
	author: member(handle),
	ts: 1000,
});
export function first(nouls: Record<string, number> = {}): Record<string, any> {
	return Object.fromEntries(
		Object.entries({
			c0_owned_unretracted: 0.95,
			c1_owned_unretracted: 0.95,
			c2_owned_unretracted: 0.95,
			...nouls,
		}).map(([key, noul]) => [key, { type: "noul", noul }]),
	);
}
export function follow(
	options: {
		role: string;
		thread: string;
		threadProbability?: number;
		explicit_resolution?: number;
		reopening?: number;
		material_objection?: number;
	},
): Record<string, any> {
	let p = options.threadProbability ?? 0.95;
	return {
		role: {
			type: "choice",
			choice: options.role,
			confidence: p,
			probabilities: options.role === "none"
				? { none: p, support: 1 - p }
				: { [options.role]: p, none: 1 - p },
		},
		thread: {
			type: "choice",
			choice: options.thread,
			confidence: p,
			probabilities: { [options.thread]: p, none: 1 - p },
		},
		explicit_resolution: { type: "noul", noul: options.explicit_resolution ?? 0 },
		reopening: { type: "noul", noul: options.reopening ?? 0 },
		material_objection: { type: "noul", noul: options.material_objection ?? 0 },
		new_option: { type: "noul", noul: options.role === "option" ? 0.95 : 0.05 },
		planning_substance: {
			type: "noul",
			noul: ["reason", "constraint"].includes(options.role) ? 0.95 : 0.05,
		},
		support: { type: "noul", noul: options.role === "support" ? 0.95 : 0.05 },
		objection: { type: "noul", noul: options.role === "objection" ? 0.95 : 0.05 },
	};
}

export function prefix(input: PolicyInput): PolicyResult | undefined {
	return runInitialTerminals(createPolicyContext(input));
}

// Original callbacks call planEvents; this test adapter requires one of the extracted terminals.
export function terminalPolicy(input: PolicyInput): PolicyResult {
	let result = prefix(input);
	expect(result).toBeDefined();
	if (!result) throw new Error("fixture continues beyond initial policy terminals");
	return result;
}

export function inputFor(text: string): PolicyInput {
	let current = message("initial-policy", text);
	return {
		channelId: "channel",
		message: current,
		state: initialState(),
		first: {
			...first({ new_question: 0.95, enough_purpose: 0.95 }),
			act: confidentChoice("question"),
			thread_target: confidentChoice("new"),
		},
		candidates: extractQuotes(text).map(quote => ({
			...quote,
			answers: {
				...follow({ role: "question", thread: "new" }),
				duplicate: { type: "noul", noul: 0 },
			},
		})),
	};
}

export function addMatchingThread(input: PolicyInput, threadId: string): ConversationPlan.State {
	let original = { ...input.message, id: `original-${threadId}` };
	return applyInference(input.state, {
		id: `opening-${threadId}`,
		type: "thread.opened",
		threadId,
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: original.ts,
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

export function seedOptions(input: PolicyInput, count: number): void {
	for (let [index, candidate] of input.candidates.slice(0, count).entries()) {
		let thread = input.state.threads[0]!;
		input.state = applyInference(input.state, {
			id: `prior-option-${index}`,
			type: "option.added",
			threadId: thread.id,
			observedThreadVersion: thread.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: input.message.ts,
			source: {
				messageId: input.message.id,
				author: input.message.author as ConversationPlan.SourceAuthor,
				quote: candidate.quote,
				start: candidate.start,
				end: candidate.end,
				role: "option",
			},
			contribution: {
				id: `prior-contribution-${index}`,
				text: candidate.quote,
				authoring: "quoted",
			},
		}, input.message);
	}
}
