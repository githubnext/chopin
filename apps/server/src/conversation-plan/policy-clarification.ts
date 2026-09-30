import type { ConversationPlan } from "@chopin/protocol";
import type { JevAnswer } from "./jev";
import type { PolicyInput } from "./policy-types";
import { isBareEditorOptionList } from "./quotes";
import { choice, moderateChoice, noul, roleChoice } from "./policy-scoring";

export function bareEditorCardEmpty(input: PolicyInput, thread: ConversationPlan.Thread): boolean {
	let card = input.linkedCards?.get(thread.id);
	if (!thread.questionnaireId) return !card;
	return card?.cardId === thread.questionnaireId && card.options.length === 0;
}

/** Only this exact four-span, empty-thread case may ask for a joint second judgment. */
export function bareEditorClarificationThread(
	input: PolicyInput,
): ConversationPlan.Thread | undefined {
	let { message, first } = input;
	if (message.author.kind !== "member" || !isBareEditorOptionList(message.text, input.candidates)) {
		return;
	}
	let open = input.state.threads.filter(item => !["decided", "discarded"].includes(item.status));
	let thread = open.length === 1 ? open[0] : undefined;
	if (
		!thread || !/\beditor\b/i.test(thread.question)
		|| thread.contributions.some(item => item.kind === "option")
		|| !bareEditorCardEmpty(input, thread)
		|| choice(first, "thread_target") !== thread.id
		|| noul(first, "new_option") < 0.9
	) return;
	let labels = input.candidates.map(item => item.quote.replace(/^bare\s+/i, "").toLowerCase());
	if (new Set(labels).size !== 4) return;
	if (
		!input.candidates.every((candidate, index) =>
			message.text.slice(candidate.start, candidate.end) === candidate.quote
			&& noul(first, `c${index}_owned_unretracted`) >= 0.8
			&& roleChoice(candidate.answers, first) === "option"
			&& moderateChoice(candidate.answers, "role", "option", 0.55)
			&& choice(candidate.answers, "thread") === thread.id
			&& moderateChoice(candidate.answers, "option", "new", 0.7)
			&& noul(candidate.answers, "new_option") >= 0.7
			&& noul(candidate.answers, "duplicate") < 0.5
		)
	) return;
	return thread;
}

export function strongBareEditorClarification(
	answers: Record<string, JevAnswer> | undefined,
): boolean {
	if (!answers) return false;
	let kind = answers.list_kind;
	if (kind?.type !== "choice" || kind.choice !== "four_distinct_options") return false;
	let selected = kind.probabilities.four_distinct_options ?? 0;
	let other = Math.max(kind.probabilities.other ?? 0, kind.probabilities.unclear ?? 0);
	return kind.confidence >= 0.8 && selected >= 0.9 && selected - other >= 0.3
		&& Array.from({ length: 4 }, (_, index) => noul(answers, `c${index}_distinct_option`) >= 0.9)
			.every(Boolean);
}
