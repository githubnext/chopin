import { applyInference } from "./domain";
import { OWNED_QUOTE_MIN } from "./policy-cues";
import type { PolicyContext } from "./policy-context";
import { choice, noul } from "./policy-scoring";
import type { Event, PolicyResult } from "./policy-types";
import { declarativeAlternativeQuotes } from "./quotes";

export function declarativePair(context: PolicyContext): PolicyResult | undefined {
	let { input, message, first, events, reviews, outcomes } = context;
	let { optionLabels } = context.facts!;
	let quotedOption = context.quotedOption!;
	let declarative = declarativeAlternativeQuotes(message.text);
	if (declarative.length === 2) {
		let target = choice(first, "thread_target");
		let thread = input.state.threads.find(item => item.id === target);
		let wholeTarget = first.thread_target;
		let certainCandidates = input.candidates.map(candidate =>
			choice(candidate.answers, "thread") === target
		);
		let corroboratedTarget = wholeTarget?.type === "choice"
			&& (wholeTarget.probabilities[target ?? ""] ?? 0) >= 0.95
			&& certainCandidates.some(Boolean);
		let candidateTargets = input.candidates.map((candidate, index) => {
			if (certainCandidates[index]) return true;
			let answer = candidate.answers.thread;
			if (!corroboratedTarget || answer?.type !== "choice" || answer.choice !== target) {
				return false;
			}
			let probability = answer.probabilities[target ?? ""] ?? 0;
			let alternative = Math.max(
				0,
				...Object.entries(answer.probabilities)
					.filter(([key]) => key !== target).map(([, value]) => value),
			);
			return probability >= 0.55 && probability - alternative >= 0.2;
		});
		let existing = new Set(
			thread?.contributions.filter(item => item.kind === "option")
				.map(item => item.text.trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ").toLowerCase()),
		);
		let optionEvidence = noul(first, "new_option") >= 0.8
			|| input.candidates.some(candidate =>
				noul(candidate.answers, "new_option") >= 0.75
				|| candidate.answers.role?.type === "choice"
					&& candidate.answers.role.choice === "option"
					&& (candidate.answers.role.probabilities.option ?? 0) >= 0.75
			);
		let eligible = message.author.kind === "member" && !!thread
			&& !["decided", "discarded"].includes(thread.status)
			&& optionEvidence
			&& declarative.every((quote, index) =>
				quote.quote === input.candidates[index]?.quote
				&& quote.start === input.candidates[index]?.start
				&& quote.end === input.candidates[index]?.end
				&& noul(first, `c${index}_owned_unretracted`) >= OWNED_QUOTE_MIN
				&& candidateTargets[index]
				&& noul(input.candidates[index]!.answers, "duplicate")
					< (certainCandidates[index] ? 0.3 : 0.5)
				&& !existing.has(optionLabels[index])
			)
			&& input.candidates.length === 2
			&& new Set(optionLabels).size === 2;
		if (!eligible || !thread) {
			return {
				events,
				candidates: reviews,
				outcomes: input.candidates.map(candidate => ({
					start: candidate.start,
					end: candidate.end,
					status: "review",
					gate: "declarative options need review",
					eventIds: [],
				})),
				policyGate: "declarative options need review",
			};
		}
		let staged = input.state;
		let additions: Event[] = [];
		for (let [index, candidate] of input.candidates.entries()) {
			let added = quotedOption(candidate, index, thread.id, staged);
			try {
				staged = applyInference(staged, added, message);
			} catch {
				return {
					events,
					candidates: reviews,
					outcomes,
					policyGate: "declarative options rejected",
				};
			}
			additions.push(added);
		}
		return {
			events: additions,
			selectedTarget: thread.id,
			candidates: reviews,
			outcomes: input.candidates.map((candidate, index) => ({
				start: candidate.start,
				end: candidate.end,
				status: "accepted",
				gate: "accepted",
				eventIds: [additions[index]!.id],
				targetId: thread.id,
			})),
			policyGate: "declarative options accepted",
		};
	}
}
