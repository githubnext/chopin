import type { ConversationPlan } from "@chopin/protocol";
import { applyInference } from "./domain";
import { planEvents } from "./policy";
import { stateWithOption } from "./policy-terminal.test-fixtures";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";

export function stateWithOptions(
	questionText: string,
	threadId: string,
	options: Array<{ id: string; text: string }>,
): ConversationPlan.State {
	let [firstOption, ...rest] = options;
	if (!firstOption) throw new Error("test thread needs an initial option");
	let state = stateWithOption(questionText, threadId, firstOption.id, firstOption.text);
	for (let [index, option] of rest.entries()) {
		let source = message(`option-${threadId}-${index + 1}`, option.text);
		let thread = state.threads.find(item => item.id === threadId);
		if (!thread) throw new Error("test option thread disappeared");
		state = applyInference(state, {
			id: `option-added-${threadId}-${index + 1}`,
			type: "option.added",
			threadId,
			observedThreadVersion: thread.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: source.ts,
			source: {
				messageId: source.id,
				author: source.author as ConversationPlan.SourceAuthor,
				quote: source.text,
				start: 0,
				end: source.text.length,
				role: "option",
			},
			contribution: {
				id: option.id,
				text: option.text,
				authoring: "quoted",
				targetId: threadId,
			},
		}, source);
	}
	return state;
}

export function planD03ContrastiveM2(role: "option" | "reason") {
	let threadId = "notification-thread";
	let relayId = "smtp-relay";
	let state = stateWithOptions(
		"Which service sends transactional notifications?",
		threadId,
		[
			{ id: relayId, text: "SMTP relay" },
			{ id: "postmark", text: "Postmark" },
			{ id: "ses", text: "SES" },
		],
	);
	let current = message(
		"d03-m2",
		"relay is cheap but delivery reports are rough.",
		"Dan",
	);
	let candidate = {
		quote: current.text,
		start: 0,
		end: current.text.length,
	};
	let result = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: {
			...first(role === "option" ? { new_option: 0.98 } : { reason: 0.96 }),
			act: confidentChoice(role === "option" ? "proposal" : "evaluation"),
			thread_target: confidentChoice(threadId),
			significance: {
				type: "score",
				score: 2,
				confidence: 0.95,
				legend: { "0": "chatter", "1": "minor", "2": "useful", "3": "work" },
				probabilities: { "0": 0, "1": 0.05, "2": 0.9, "3": 0.05 },
			},
		},
		candidates: [{
			...candidate,
			answers: {
				...follow({ role, thread: threadId }),
				option: confidentChoice(role === "option" ? "new" : relayId),
				...(role === "option" ? { chosen_option: confidentChoice("new") } : {}),
				...(role === "reason" ? { relation: confidentChoice("supports") } : {}),
				new_option: { type: "noul", noul: role === "option" ? 0.98 : 0.05 },
				planning_substance: { type: "noul", noul: 0.95 },
				duplicate: { type: "noul", noul: 0.02 },
			},
		}],
	});
	return { result, current, relayId };
}
