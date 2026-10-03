import type { Chat, ConversationPlan } from "@chopin/protocol";
import { applyInference, completeAnalysis, enqueue, initialState } from "./domain";
import { applyEvent } from "./events";

import { entry, harness, opened } from "./service.test-fixtures";

// Exact helpers from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
export function excerptCorrectionSetup(options: {
	text?: string;
	selectedText?: string;
	outcome?: "review" | "ignored" | "accepted" | "missing";
	outcomeRange?: [number, number];
	threadStatus?: "open" | "discarded";
	duplicateSource?: boolean;
	linked?: boolean;
} = {}) {
	let setup = harness();
	let question = entry("question", "Which service should send notification emails?");
	setup.plan.chat.entries.push(question);
	let state = applyInference(initialState(), opened(question), question);
	let option = entry("existing-option", "Use a current SMTP service.");
	setup.plan.chat.entries.push(option);
	state = applyInference(state, {
		id: "option:existing",
		type: "option.added",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: option.ts,
		source: {
			messageId: option.id,
			author: option.author as ConversationPlan.SourceAuthor,
			quote: option.text,
			start: 0,
			end: option.text.length,
			role: "option",
		},
		contribution: {
			id: "01K0N4W3B7P27CBAEC7A8C8WEB",
			text: option.text,
			authoring: "quoted",
			targetId: "thread-a",
		},
	}, option);
	if (options.linked !== false) {
		state = applyEvent(state, {
			id: "card-link",
			type: "card.linked",
			threadId: "thread-a",
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 1001,
			questionnaireId: "01K0N4W3B7P27CBAEC7A8C8WEA",
		});
	}
	let excerpt: Chat.Entry = {
		...entry(
			"excerpt",
			options.text ?? "By agent access I mean Copilot or bring-your-own API keys.",
		),
		author: { kind: "member", handle: "alice" },
	};
	setup.plan.chat.entries.push(excerpt);
	let selected = options.selectedText ?? "Copilot";
	let start = excerpt.text.indexOf(selected);
	let end = start + selected.length;
	if (options.duplicateSource) {
		state = applyInference(state, {
			id: "already-classified-excerpt",
			type: "reason.added",
			threadId: "thread-a",
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: excerpt.ts,
			source: {
				messageId: excerpt.id,
				author: excerpt.author as ConversationPlan.SourceAuthor,
				quote: selected,
				start,
				end,
				role: "reason",
			},
			contribution: {
				id: "existing-excerpt-reason",
				text: selected,
				authoring: "quoted",
				targetId: "thread-a",
			},
		}, excerpt);
	}
	if (options.threadStatus === "discarded") {
		state = applyEvent(state, {
			id: "discard-thread",
			type: "thread.discarded",
			threadId: "thread-a",
			observedThreadVersion: state.threads[0]!.version,
			origin: "human",
			actor: { kind: "member", handle: "ana" },
			at: excerpt.ts,
		});
	}
	state = enqueue(state, excerpt.id);
	state = completeAnalysis(state, excerpt.id, [], excerpt, {
		questionSetVersion: "conversation-plan-5",
		modelVersion: "jev-test",
		status: "unlinked",
		passes: [],
		outcomes: options.outcome === "missing"
			? []
			: [{
				start: options.outcomeRange?.[0] ?? 0,
				end: options.outcomeRange?.[1] ?? excerpt.text.length,
				status: options.outcome === "accepted" ? "accepted" : options.outcome ?? "review",
				gate: "unclassified excerpt",
				eventIds: [],
			}],
	});
	setup.plan.conversationPlan = state;
	let cardId = state.threads[0]!.questionnaireId;
	if (cardId) {
		setup.plan.records.set(cardId, {
			id: cardId,
			threadId: "thread-a",
			status: options.threadStatus === "discarded" ? "cancelled" : "open",
			origin: "conversation",
			definition: {
				questions: [{
					id: "01K0N4W3B7P27CBAEC7A8C8WEC",
					header: "Notifications",
					question: question.text,
					multiple: false,
					options: [{
						id: "01K0N4W3B7P27CBAEC7A8C8WEB",
						label: option.text,
						description: "",
					}],
				}],
			},
			history: [],
			optionOrigins: {},
			editors: [],
		});
	}
	return { setup, excerpt, start, end };
}

export function excerptAction(
	state: ConversationPlan.State,
	excerpt: Chat.Entry,
	start: number,
	end: number,
	change: Record<string, unknown> = { contributionKind: "reason" },
): ConversationPlan.CorrectionAction {
	return {
		actionId: "add-excerpt",
		threadId: "thread-a",
		expectedVersion: state.threads[0]!.version,
		change: {
			kind: "add-excerpt",
			messageId: excerpt.id,
			start,
			end,
			...change,
		} as unknown as ConversationPlan.CorrectionChange,
	} as ConversationPlan.CorrectionAction;
}
