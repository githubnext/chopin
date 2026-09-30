import { applyInference } from "./domain";
import {
	bareEditorCardEmpty,
	bareEditorClarificationThread,
	strongBareEditorClarification,
} from "./policy-clarification";
import type { PolicyContext } from "./policy-context";
import { OWNED_QUOTE_MIN } from "./policy-cues";
import { choice, noul, roleChoice } from "./policy-scoring";
import type { Event, PolicyResult } from "./policy-types";
import { isBareEditorOptionList } from "./quotes";

export function bareEditorList(context: PolicyContext): PolicyResult | undefined {
	let { input, message, first, events, reviews, outcomes } = context;
	let quotedOption = context.quotedOption!;
	if (isBareEditorOptionList(message.text, input.candidates)) {
		let open = input.state.threads.filter(thread =>
			!["decided", "discarded"].includes(thread.status)
		);
		let thread = open.length === 1 ? open[0] : undefined;
		let existing = new Set(
			thread?.contributions.filter(item => item.kind === "option")
				.map(item => item.text.trim().replace(/^bare\s+/i, "").toLowerCase()),
		);
		let stronglyEligible = message.author.kind === "member" && !!thread
			&& /\beditor\b/i.test(thread.question)
			&& bareEditorCardEmpty(input, thread)
			&& choice(first, "thread_target") === thread.id
			&& noul(first, "new_option") >= 0.8
			&& input.candidates.every((candidate, index) =>
				noul(first, `c${index}_owned_unretracted`) >= OWNED_QUOTE_MIN
				&& roleChoice(candidate.answers, first) === "option"
				&& choice(candidate.answers, "thread") === thread.id
				&& choice(candidate.answers, "option") === "new"
				&& noul(candidate.answers, "new_option") >= 0.8
				&& noul(candidate.answers, "duplicate") < 0.3
				&& !existing.has(candidate.quote.replace(/^bare\s+/i, "").toLowerCase())
			);
		let clarified = bareEditorClarificationThread(input);
		let eligible = stronglyEligible
			|| !!thread && clarified?.id === thread.id
				&& strongBareEditorClarification(input.clarification);
		if (!eligible || !thread) {
			return {
				events,
				candidates: reviews,
				outcomes: input.candidates.map(candidate => ({
					start: candidate.start,
					end: candidate.end,
					status: "review",
					gate: "bare editor list needs one clear current thread",
					eventIds: [],
				})),
				policyGate: "bare editor list needs review",
			};
		}
		let staged = input.state;
		let additions: Event[] = [];
		for (let [index, candidate] of input.candidates.entries()) {
			let added = quotedOption(candidate, index, thread.id, staged);
			try {
				staged = applyInference(staged, added, message);
			} catch {
				return { events, candidates: reviews, outcomes, policyGate: "bare editor list rejected" };
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
			policyGate: "bare editor list accepted",
		};
	}
}
