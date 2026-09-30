import { applyInference } from "./domain";
import type { DirectFacts, PolicyContext } from "./policy-context";
import { stableId } from "./policy-identity";
import { choice, moderateChoice, noul } from "./policy-scoring";
import type { Event, PolicyResult } from "./policy-types";
import { isAttributedCompoundDecision, isExplicitCompoundDecision } from "./quotes";

export function topicCorroboration(
	context: PolicyContext,
	facts: DirectFacts,
): PolicyResult | undefined {
	let { input, message, first, events, reviews } = context;
	let { topicThreeWay, exactDirectAlternatives, directBounds } = facts;
	if (
		topicThreeWay && !(message.author.kind === "member"
			&& exactDirectAlternatives && directBounds
			&& input.candidates.every((candidate, index) =>
				noul(first, `c${index}_owned_unretracted`) >= 0.8
				&& ["role", "thread", "option"].every(key =>
					candidate.answers[key]?.type === "choice"
					&& candidate.answers[key].confidence >= 0.8
				)
				&& moderateChoice(candidate.answers, "role", "option", 0.8)
				&& moderateChoice(candidate.answers, "thread", "new", 0.8)
				&& moderateChoice(candidate.answers, "option", "new", 0.8)
				&& candidate.answers.new_option?.type === "noul"
				&& noul(candidate.answers, "new_option") >= 0.85
				&& candidate.answers.duplicate?.type === "noul"
				&& noul(candidate.answers, "duplicate") <= 0.2
			))
	) {
		return {
			events,
			candidates: reviews,
			outcomes: input.candidates.map(candidate => ({
				start: candidate.start,
				end: candidate.end,
				status: "review",
				gate: "topic alternatives need candidate corroboration",
				eventIds: [],
			})),
			policyGate: "topic alternatives need candidate corroboration",
		};
	}
}

export function compoundAttribution(context: PolicyContext): PolicyResult | undefined {
	let { input, message, events, reviews } = context;
	if (isAttributedCompoundDecision(message.text, input.candidates)) {
		return {
			events,
			candidates: reviews,
			outcomes: input.candidates.map(candidate => ({
				start: candidate.start,
				end: candidate.end,
				status: "review",
				gate: "compound decision attribution unclear",
				eventIds: [],
			})),
			policyGate: "compound decision attribution unclear",
		};
	}
}

export function compoundOpenings(context: PolicyContext): PolicyResult | undefined {
	let { input, channelId, message, first, reviews } = context;
	if (
		message.author.kind === "member" && input.state.threads.length === 0
		&& isExplicitCompoundDecision(message.text, input.candidates)
		&& noul(first, "new_question") >= 0.55
		&& noul(first, "enough_purpose") >= 0.8
		&& choice(first, "act") === "question"
		&& choice(first, "thread_target") === "new"
		&& input.candidates.every((candidate, index) =>
			noul(first, `c${index}_owned_unretracted`) >= 0.8
			&& moderateChoice(candidate.answers, "role", "question", 0.55)
			&& choice(candidate.answers, "thread") === "new"
			&& noul(candidate.answers, "duplicate") < 0.3
		)
	) {
		let staged = input.state;
		let openings: Event[] = [];
		for (let [index, candidate] of input.candidates.entries()) {
			let threadId = `thread:${stableId(channelId, message.id, index, "thread").slice(11)}`;
			let opening: Event = {
				id: stableId(channelId, message.id, index, "thread.opened"),
				type: "thread.opened",
				threadId,
				observedThreadVersion: 0,
				origin: "classifier",
				actor: { kind: "classifier" },
				at: message.ts,
				source: {
					messageId: message.id,
					author: message.author,
					quote: candidate.quote,
					start: candidate.start,
					end: candidate.end,
					role: "question",
				},
				question: candidate.quote,
			};
			try {
				staged = applyInference(staged, opening, message);
			} catch {
				openings = [];
				break;
			}
			openings.push(opening);
		}
		if (openings.length === input.candidates.length) {
			return {
				events: openings,
				selectedTarget: openings[0]!.threadId,
				candidates: reviews,
				outcomes: input.candidates.map((candidate, index) => ({
					start: candidate.start,
					end: candidate.end,
					status: "accepted",
					gate: "accepted",
					eventIds: [openings[index]!.id],
					targetId: openings[index]!.threadId,
				})),
				policyGate: "explicit compound questions accepted",
			};
		}
	}
}
