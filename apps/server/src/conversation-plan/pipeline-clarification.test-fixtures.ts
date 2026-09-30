import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";
import { interpretMessage } from "./interpret";
import { planEvents } from "./policy";
import { mockResult } from "./interpret.test-fixtures";
import { d01RecordedOpening } from "./policy-terminal.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

export async function d01LiveListWithClarification(options: {
	text?: string;
	clarification?: "strong" | "weak" | "missing" | "failed";
	changedModel?: boolean;
	state?: "no-thread" | "existing-option" | "linked-card" | "competing-thread";
	owned?: number;
} = {}) {
	let opening = d01RecordedOpening();
	let state = applyInference(opening.state, planEvents(opening).events[0]!, opening.message);
	let threadId = state.threads[0]!.id;
	if (options.state === "no-thread") state = initialState();
	if (options.state === "linked-card") state.threads[0]!.questionnaireId = "editor-card";
	let linkedCards = options.state === "linked-card"
		? new Map([[threadId, {
			cardId: "editor-card",
			options: [{ id: "existing-card-option", label: "Slate" }],
		}]])
		: undefined;
	if (options.state === "existing-option") {
		let prior = message("prior-tiptap", "Tiptap.", "Rob");
		state = applyInference(state, {
			id: "prior-tiptap-added",
			type: "option.added",
			threadId,
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: prior.ts,
			source: {
				messageId: prior.id,
				author: prior.author as ConversationPlan.SourceAuthor,
				quote: "Tiptap",
				start: 0,
				end: 6,
				role: "option",
			},
			contribution: {
				id: "prior-tiptap-option",
				text: "Tiptap",
				authoring: "quoted",
				targetId: threadId,
			},
		}, prior);
	}
	if (options.state === "competing-thread") {
		let prior = message("competing-question", "Which database should we use?", "Rob");
		state = applyInference(state, {
			id: "competing-thread-opened",
			type: "thread.opened",
			threadId: "competing-thread",
			observedThreadVersion: 0,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: prior.ts,
			source: {
				messageId: prior.id,
				author: prior.author as ConversationPlan.SourceAuthor,
				quote: prior.text,
				start: 0,
				end: prior.text.length,
				role: "question",
			},
			question: prior.text,
		}, prior);
	}
	let current = message(
		"d01-m2-live-clarification",
		options.text
			?? "Tiptap, bare ProseMirror, Lexical, or just native Selection and Range with our own document model.",
		"Rob",
	);
	let clarifications = 0;
	let output = await interpretMessage({
		channelId: "channel",
		message: current,
		recent: [opening.message],
		state,
		linkedCards,
		ask: async request => {
			if ("list_kind" in request.questions) {
				clarifications++;
				if (options.clarification === "failed") throw new Error("Jev unavailable");
				let strong = options.clarification === "strong";
				let result = mockResult(request.questions, {
					list_kind: strong ? "four_distinct_options" : "unclear",
					...Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
						`c${index}_distinct_option`,
						strong ? 0.95 : 0.3,
					])),
				});
				if (options.clarification === "missing") {
					delete result.answers.list_kind;
					for (let index = 0; index < 4; index++) {
						delete result.answers[`c${index}_distinct_option`];
					}
				}
				if (options.changedModel) result.model = "different-jev";
				return result;
			}
			if ("new_question" in request.questions) {
				let result = mockResult(request.questions, {
					new_option: 0.94,
					act: "proposal",
					thread_target: threadId,
					significance: 2,
					c0_owned_unretracted: 0.92,
					c1_owned_unretracted: 0.91,
					c2_owned_unretracted: 0.92,
					c3_owned_unretracted: options.owned ?? 0.94,
				});
				result.answers.thread_target.confidence = 0.88;
				result.answers.thread_target.probabilities = {
					[threadId]: 0.92,
					new: 0.01,
					none: 0.07,
				};
				return result;
			}
			let prefix = Object.keys(request.questions).find(key => /^c[0-3]_role$/.test(key))
				?.slice(0, 2);
			if (!prefix) throw new Error("Unexpected Jev request");
			let index = Number(prefix[1]);
			let result = mockResult(request.questions, {
				[`${prefix}_role`]: "option",
				[`${prefix}_thread`]: threadId,
				[`${prefix}_option`]: "new",
				[`${prefix}_new_option`]: [0.75, 0.91, 0.89, 0.95][index]!,
				[`${prefix}_duplicate`]: [0.44, 0.24, 0.23, 0.27][index]!,
			});
			let role = result.answers[`${prefix}_role`];
			role.confidence = [0.55, 0.78, 0.92, 0.84][index]!;
			role.probabilities = {
				option: [0.61, 0.81, 0.93, 0.87][index]!,
				resolution: [0.23, 0.08, 0.01, 0.12][index]!,
				none: [0.15, 0.09, 0.05, 0.01][index]!,
			};
			let option = result.answers[`${prefix}_option`];
			option.confidence = [0.65, 0.56, 0.51, 0.87][index]!;
			option.probabilities = {
				new: [0.83, 0.78, 0.75, 0.93][index]!,
				none: [0.17, 0.22, 0.25, 0.07][index]!,
			};
			return result;
		},
	});
	return { output, current, state, threadId, clarifications, linkedCards };
}
