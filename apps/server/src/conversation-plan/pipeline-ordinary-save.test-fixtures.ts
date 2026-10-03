import { expect } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";
import { interpretMessage } from "./interpret";
import { mockResult, seededOptionId } from "./interpret.test-fixtures";
import { stateWithOption } from "./policy-terminal.test-fixtures";

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2 pipeline.test.ts declarations.
export type MockAnswers = Record<string, string | number>;

export type MockMutation = (result: any, prefix?: string) => void;

export function emailState(): ConversationPlan.State {
	return stateWithOption(
		"Which service should send notification emails?",
		"email-thread",
		"existing-mailgun",
		"We should use Mailgun for notification emails.",
	);
}

export function proposalTriage(
	target: string,
	act = "proposal",
	overrides: MockAnswers = {},
): MockAnswers {
	return {
		new_question: 0.1,
		new_option: 0.98,
		act,
		thread_target: target,
		significance: 2,
		explicit_resolution: 0.1,
		...overrides,
	};
}

export function newChoiceAnswers(
	prefix: string,
	target: string,
	overrides: MockAnswers = {},
): MockAnswers {
	return withCandidateOverrides(prefix, {
		[`${prefix}_role`]: "resolution",
		[`${prefix}_thread`]: target,
		[`${prefix}_option`]: "new",
		[`${prefix}_chosen_option`]: "new",
		[`${prefix}_new_option`]: 0.98,
		[`${prefix}_planning_substance`]: 0.96,
		[`${prefix}_support`]: 0.96,
		[`${prefix}_explicit_resolution`]: 0.1,
		[`${prefix}_duplicate`]: 0.04,
	}, overrides);
}

export function knownChoiceAnswers(
	prefix: string,
	target: string,
	option: string,
	role = "resolution",
	overrides: MockAnswers = {},
): MockAnswers {
	return withCandidateOverrides(prefix, {
		[`${prefix}_role`]: role,
		[`${prefix}_thread`]: target,
		[`${prefix}_option`]: option,
		[`${prefix}_chosen_option`]: option,
		[`${prefix}_new_option`]: 0.05,
		[`${prefix}_planning_substance`]: 0.05,
		[`${prefix}_support`]: 0.96,
		[`${prefix}_explicit_resolution`]: 0.1,
		[`${prefix}_duplicate`]: 0.04,
	}, overrides);
}

export function withCandidateOverrides(
	prefix: string,
	answers: MockAnswers,
	overrides: MockAnswers,
): MockAnswers {
	for (let [key, value] of Object.entries(overrides)) {
		answers[key.startsWith(`${prefix}_`) ? key : `${prefix}_${key}`] = value;
	}
	return answers;
}

export async function mockInterpret(
	current: Chat.Entry,
	state: ConversationPlan.State,
	triage: MockAnswers,
	candidate: (prefix: string) => MockAnswers,
	mutate?: MockMutation,
	recent: readonly Chat.Entry[] = [],
) {
	return interpretMessage({
		channelId: "channel",
		message: current,
		recent,
		state,
		ask: async request => {
			let isTriage = "new_question" in request.questions;
			let prefix = Object.keys(request.questions).find(key => /^c\d+_role$/.test(key))
				?.replace(/_role$/, "");
			let result = mockResult(request.questions, isTriage ? triage : candidate(prefix ?? "c0"));
			mutate?.(result, isTriage ? undefined : prefix);
			return result;
		},
	});
}

export function expectSourcedOptionSave(
	events: ConversationPlan.Event[],
	threadId: string,
	quote: { quote: string; start: number; end: number },
): void {
	expect(events.map(event => event.type)).toEqual(["option.added", "settle.suggested"]);
	let added = events[0];
	expect(added).toMatchObject({
		type: "option.added",
		threadId,
		contribution: { text: quote.quote },
		source: { ...quote, role: "option" },
	});
	expect(events[1]).toMatchObject({
		type: "settle.suggested",
		threadId,
		optionId: added?.type === "option.added" ? added.contribution.id : undefined,
		source: { ...quote, role: "resolution" },
	});
}

export function optionChoice(choice: string): any {
	return {
		type: "choice",
		choice,
		confidence: 0.95,
		probabilities: Object.fromEntries(
			[seededOptionId, "new", "none"].map((key) => [key, key === choice ? 0.96 : 0.02]),
		),
	};
}
