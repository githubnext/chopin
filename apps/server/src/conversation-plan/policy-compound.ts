import { applyInference } from "./domain";
import type { DirectFacts, PolicyContext } from "./policy-context";
import { OWNED_QUOTE_MIN } from "./policy-cues";
import { stableId } from "./policy-identity";
import { choice, moderateChoice, noul, roleChoice } from "./policy-scoring";
import type { Event, PolicyResult } from "./policy-types";
import {
	explicitListQuotes,
	isAttributedCompoundDecision,
	isExplicitCompoundDecision,
	multiAlternativeQuotes,
} from "./quotes";

export function questionListCorroboration(
	context: PolicyContext,
	facts: DirectFacts,
): PolicyResult | undefined {
	let { input, message, first, events, reviews } = context;
	let { questionList, exactDirectAlternatives, directBounds } = facts;
	let questionBeforeOptions = message.text.indexOf("?") >= 0
		&& message.text.indexOf("?") < (input.candidates[0]?.start ?? 0);
	let listed = explicitListQuotes(message.text);
	if (
		input.candidates.length >= 3 && /,\s*or\s+/i.test(message.text)
		&& (questionBeforeOptions
			|| !message.text.trimEnd().endsWith("?")
				&& multiAlternativeQuotes(message.text).length === 0)
	) {
		let exact = listed.length === input.candidates.length
			&& listed.every((quote, index) =>
				quote.quote === input.candidates[index]?.quote
				&& quote.start === input.candidates[index]?.start
				&& quote.end === input.candidates[index]?.end
			);
		let open = input.state.threads.filter(thread =>
			!["decided", "discarded"].includes(thread.status)
		);
		let thread = open.length === 1 ? open[0] : undefined;
		let card = thread && input.linkedCards?.get(thread.id);
		let bareList = !questionBeforeOptions;
		let supported = !bareList || message.author.kind === "member" && !!thread
				&& (!card || card.options.length === 0)
				&& choice(first, "thread_target") === thread.id
				&& noul(first, "new_option") >= 0.8
				&& input.candidates.every((candidate, index) =>
					noul(first, `c${index}_owned_unretracted`) >= OWNED_QUOTE_MIN
					&& roleChoice(candidate.answers, first) === "option"
					&& choice(candidate.answers, "thread") === thread.id
					&& choice(candidate.answers, "option") === "new"
					&& noul(candidate.answers, "new_option") >= 0.8
					&& noul(candidate.answers, "duplicate") < 0.3
					&& !thread.contributions.some(item =>
						item.kind === "option"
						&& item.text.trim().toLowerCase() === candidate.quote.trim().toLowerCase()
					)
				);
		if (!exact || !supported) {
			return {
				events,
				candidates: reviews,
				outcomes: input.candidates.map(candidate => ({
					start: candidate.start,
					end: candidate.end,
					status: "review",
					gate: "alternative list source needs review",
					eventIds: [],
				})),
				policyGate: "alternative list source needs review",
			};
		}
	}
	if (
		questionList && !(message.author.kind === "member"
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
				gate: "question alternatives need candidate corroboration",
				eventIds: [],
			})),
			policyGate: "question alternatives need candidate corroboration",
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
