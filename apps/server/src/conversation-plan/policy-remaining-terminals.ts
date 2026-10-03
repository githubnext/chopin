import type { PolicyContext } from "./policy-context";
import { declarativePair } from "./policy-declarative";
import { directAlternatives } from "./policy-direct-alternatives";
import { purposeAndQuestion } from "./policy-purpose-question";
import { choice, noul } from "./policy-scoring";
import type { PolicyResult } from "./policy-types";

/** Run after initial terminals continue; facts and quotedOption retain their original captures. */
export function runRemainingTerminals(context: PolicyContext): PolicyResult | undefined {
	let { message, first } = context;
	let { exactDirectAlternatives, matchingThreads } = context.facts!;
	let directQuestion = exactDirectAlternatives && !matchingThreads.length
		&& message.text.length <= 500 && noul(first, "new_question") >= 0.9
		&& choice(first, "act") === "question" && choice(first, "thread_target") === "new";

	context.directQuestion = directQuestion;
	let result = directAlternatives(context, directQuestion);
	if (result) return result;
	result = declarativePair(context);
	if (result) return result;
	return purposeAndQuestion(context);
}
