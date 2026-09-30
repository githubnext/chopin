import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { JevQuestion, JevRequest } from "./jev";
import { isBareEditorOptionList, type QuoteCandidate } from "./quotes";
import { noul } from "./question-shared";

/** One joint judgment over four already extracted, exact source spans. */
export function buildBareEditorClarificationRequest(
	message: Chat.Entry,
	thread: ConversationPlan.Thread,
	candidates: readonly QuoteCandidate[],
): JevRequest {
	if (
		message.author.kind !== "member" || !isBareEditorOptionList(message.text, candidates)
		|| !["exploring", "leaning", "reopened"].includes(thread.status)
		|| thread.contributions.some(item => item.kind === "option")
	) throw new Error("invalid bare editor clarification context");
	let questions: Record<string, JevQuestion> = {
		list_kind: {
			type: "choice",
			instructions:
				"Judge the four exact spans in spans[] together. Are they four distinct, directly proposed editor options owned by current.author for the one thread, rather than a quote, report, negation, duplicate, or one compound option? Do not invent or rewrite any span.",
			criteria: {
				four_distinct_options:
					"All four spans are separate sincere options for the one editor decision.",
				other: "The spans are not four distinct speaker-owned options.",
				unclear: "The list's ownership, target, or four-way structure is uncertain.",
			},
		},
	};
	for (let index = 0; index < 4; index++) {
		questions[`c${index}_distinct_option`] = noul(
			`Does spans[${index}].quote itself name one distinct option for thread.question, separate from the other three exact spans? Require this speaker's own current proposal; reported, negated, duplicate, or uncertain alternatives are false.`,
			"A distinct directly proposed editor option in this exact span.",
			"Not a distinct directly proposed option in this span.",
		);
	}
	return {
		state: {
			current: { id: message.id, author: message.author, text: message.text },
			thread: {
				id: thread.id,
				question: thread.question,
				status: thread.status,
				version: thread.version,
				options: [],
			},
			spans: candidates.map((candidate, index) => ({ index, ...candidate })),
		},
		questions,
	};
}
