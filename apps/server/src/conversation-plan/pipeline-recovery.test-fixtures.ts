import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";
import { interpretMessage } from "./interpret";
import { mockResult } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

export let interpretLowOwnership = (
	id: string,
	text: string,
	options: {
		weakFragments?: boolean;
		state?: ConversationPlan.State;
		triageTarget?: string;
		newQuestion?: number;
		candidateThreadTarget?: string;
		candidateThreadTargets?: Record<string, string>;
		candidateRoles?: Record<string, string>;
		candidateDuplicates?: Record<string, number>;
	} = {},
) => {
	let {
		weakFragments = true,
		state = initialState(),
		triageTarget = "new",
		newQuestion = 0.97,
		candidateThreadTarget,
		candidateThreadTargets,
		candidateRoles,
		candidateDuplicates,
	} = options;
	return interpretMessage({
		channelId: "channel",
		message: message(`low-ownership-${id}`, text, "Jules"),
		recent: [],
		state,
		ask: async request => {
			if ("new_question" in request.questions) {
				let overrides: Record<string, string | number> = {
					new_question: newQuestion,
					new_option: 0.36,
					act: "question",
					thread_target: triageTarget,
					significance: 2,
				};
				for (let key of Object.keys(request.questions)) {
					if (key.endsWith("_owned_unretracted")) overrides[key] = 0.6;
				}
				return mockResult(request.questions, overrides);
			}
			let overrides: Record<string, string | number> = {};
			for (let key of Object.keys(request.questions)) {
				if (!key.startsWith("c")) continue;
				if (key.endsWith("_role")) {
					overrides[key] = candidateRoles?.[key]
						?? (weakFragments && key.startsWith("c0_") ? "none" : "option");
				}
				if (key.endsWith("_thread")) {
					overrides[key] = candidateThreadTargets?.[key]
						?? (weakFragments && key.startsWith("c0_")
							? "none"
							: candidateThreadTarget ?? "new");
				}
				if (key.endsWith("_new_option")) {
					overrides[key] = weakFragments && key.startsWith("c0_") ? 0.7 : 0.95;
				}
				if (key.endsWith("_duplicate") && candidateDuplicates?.[key] !== undefined) {
					overrides[key] = candidateDuplicates[key]!;
				}
			}
			let result = mockResult(request.questions, overrides);
			let firstRole = result.answers.c0_role;
			let roleQuestion = request.questions.c0_role;
			if (
				weakFragments && firstRole?.type === "choice" && roleQuestion?.type === "choice"
			) {
				let probabilities = Object.fromEntries(
					Object.keys(roleQuestion.criteria).map(key => [
						key,
						key === "none" ? 0.55 : key === "option" ? 0.45 : 0,
					]),
				);
				result.answers.c0_role = {
					type: "choice",
					choice: "none",
					confidence: 0.45,
					probabilities,
				};
			}
			return result;
		},
	});
};

export let stateWithQuestion = (
	threadId: string,
	text: string,
	options: readonly string[] = [],
	state = initialState(),
) => {
	let original = message(`existing-${threadId}`, text);
	state = applyInference(state, {
		id: `existing-${threadId}-question`,
		type: "thread.opened",
		threadId,
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: original.ts,
		source: {
			messageId: original.id,
			author: original.author as ConversationPlan.SourceAuthor,
			quote: text,
			start: 0,
			end: text.length,
			role: "question",
		},
		question: text,
	}, original);
	for (let [index, option] of options.entries()) {
		let start = text.indexOf(option);
		state = applyInference(state, {
			id: `existing-${threadId}-option-${index}`,
			type: "option.added",
			threadId,
			observedThreadVersion: state.threads.find(thread => thread.id === threadId)!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: original.ts,
			source: {
				messageId: original.id,
				author: original.author as ConversationPlan.SourceAuthor,
				quote: option,
				start,
				end: start + option.length,
				role: "option",
			},
			contribution: {
				id: `existing-${threadId}-option-${index}`,
				text: option,
				authoring: "quoted",
				targetId: threadId,
			},
		}, original);
	}
	return state;
};

export let repeatQuestionCases: Array<{
	id: string;
	existing: string[];
	missing: string[];
	duplicates: Record<string, number>;
}> = [
	{
		id: "empty-card",
		existing: [],
		missing: ["PostgreSQL", "object storage"],
		duplicates: {},
	},
	{
		id: "partial-card",
		existing: ["PostgreSQL"],
		missing: ["object storage"],
		duplicates: { c0_duplicate: 0.95 },
	},
	{
		id: "complete-card",
		existing: ["PostgreSQL", "object storage"],
		missing: [],
		duplicates: { c0_duplicate: 0.95, c1_duplicate: 0.95 },
	},
];
