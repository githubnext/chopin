import type { ConversationPlan } from "@chopin/protocol";
import { applyInference } from "./domain";
import type { PolicyContext } from "./policy-context";
import { OWNED_QUOTE_MIN } from "./policy-cues";
import { stableId } from "./policy-identity";
import { choice, noul, roleChoice } from "./policy-scoring";
import type { Event, PolicyResult } from "./policy-types";

export function purposeAndQuestion(context: PolicyContext): PolicyResult | undefined {
	let { input, channelId, message, first, reviews } = context;
	let [purpose, finalQuestion] = input.candidates;
	let finalTarget = finalQuestion?.answers.thread;
	let newProbability = finalTarget?.type === "choice"
		? finalTarget.probabilities.new ?? 0
		: 0;
	let competingProbability = finalTarget?.type === "choice"
		? Math.max(
			0,
			...Object.entries(finalTarget.probabilities)
				.filter(([key]) => key !== "new").map(([, probability]) => probability),
		)
		: 0;
	let purposeRole = purpose && roleChoice(purpose.answers, first);
	let purposeUsefulProbability = purpose?.answers.role?.type === "choice"
		? Math.max(
			0,
			...Object.entries(purpose.answers.role.probabilities)
				.filter(([role]) => role !== "none").map(([, probability]) => probability),
		)
		: 1;
	let purposeQuestion = message.author.kind === "member"
		&& input.state.threads.length === 0
		&& message.text.length <= 500 && input.candidates.length === 2
		&& purpose?.start === 0 && finalQuestion?.end === message.text.length
		&& purpose.end < finalQuestion.start
		&& /^\s+$/.test(message.text.slice(purpose.end, finalQuestion.start))
		&& message.text.slice(purpose.start, purpose.end) === purpose.quote
		&& message.text.slice(finalQuestion.start, finalQuestion.end) === finalQuestion.quote
		&& /^\s*(?:(?:we|i)\s+)?need to\s+(?:pick|choose|select|decide on)\b[^?]{2,300}\.$/i
			.test(purpose.quote)
		&& /^(?:what|which|how)\b[^.!?]{3,150}\?$/i.test(finalQuestion.quote)
		&& !/["“”‘’🙄]/u.test(message.text)
		&& !/\b(?:said|asked|told|claimed|reported|according to|if|unless|maybe|perhaps)\b/i
			.test(message.text)
		&& noul(first, "new_question") >= 0.8
		&& noul(first, "enough_purpose") >= 0.8
		&& choice(first, "act") === "question"
		&& choice(first, "thread_target") === "new"
		&& noul(first, "c0_owned_unretracted") >= OWNED_QUOTE_MIN
		&& noul(first, "c1_owned_unretracted") >= OWNED_QUOTE_MIN
		&& (purposeRole === undefined || purposeRole === "none")
		&& purposeUsefulProbability < 0.8
		&& purpose.answers.role?.type === "choice"
		&& (purpose.answers.role.probabilities.question ?? 0) < 0.2
		&& roleChoice(finalQuestion.answers, first) === "question"
		&& finalQuestion.answers.role?.type === "choice"
		&& (finalQuestion.answers.role.probabilities.question ?? 0) >= 0.9
		&& finalTarget?.type === "choice" && finalTarget.choice === "new"
		&& newProbability >= 0.6 && newProbability - competingProbability >= 0.2;
	if (purposeQuestion) {
		let threadId = `thread:${stableId(channelId, message.id, 1, "thread").slice(11)}`;
		let opening: Event = {
			id: stableId(channelId, message.id, 1, "thread.opened"),
			type: "thread.opened",
			threadId,
			observedThreadVersion: 0,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: message.ts,
			source: {
				messageId: message.id,
				author: message.author as ConversationPlan.SourceAuthor,
				quote: message.text,
				start: 0,
				end: message.text.length,
				role: "question",
			},
			question: message.text,
		};
		try {
			applyInference(input.state, opening, message);
			return {
				events: [opening],
				selectedTarget: threadId,
				candidates: reviews,
				outcomes: input.candidates.map((candidate, index) => ({
					start: candidate.start,
					end: candidate.end,
					status: index === 1 ? "accepted" : "ignored",
					gate: index === 1 ? "accepted" : "opening purpose",
					eventIds: index === 1 ? [opening.id] : [],
					...(index === 1 ? { targetId: threadId } : {}),
				})),
				policyGate: "owned purpose and final question accepted",
			};
		} catch {
			// Let the ordinary candidate gates report why the opening was rejected.
		}
	}
}
