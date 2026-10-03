import type { ConversationPlan } from "@chopin/protocol";
import { applyInference } from "./domain";
import type { PolicyContext } from "./policy-context";
import { OWNED_QUOTE_MIN } from "./policy-cues";
import { stableId } from "./policy-identity";
import { noul } from "./policy-scoring";
import type { CandidateJudgment, Event } from "./policy-types";

export type CandidateEntry = {
	index: number;
	candidate: CandidateJudgment;
	outcome: ConversationPlan.CandidateOutcome;
};

/** Undefined skips this candidate; setup must already exist on the captured context. */
export function beginCandidate(
	context: PolicyContext,
	index: number,
	candidate: CandidateJudgment,
): CandidateEntry | undefined {
	let { channelId, message, first, events, outcomes } = context;
	let { optionLabels } = context.facts!;
	let { seenOptionLabels } = context.candidateRun!;
	let optionGroup = context.candidateRun!.optionGroup;
	let working = context.working;
	try {
		let outcome: ConversationPlan.CandidateOutcome = {
			start: candidate.start,
			end: candidate.end,
			status: "ignored",
			gate: "no useful role",
			eventIds: [],
		};
		outcomes.push(outcome);
		if (
			message.text.slice(candidate.start, candidate.end) !== candidate.quote
			|| !candidate.quote || candidate.quote.length > 2048
		) {
			outcome.gate = "invalid source quote";
			return undefined;
		}
		if (!optionGroup && noul(first, `c${index}_owned_unretracted`) < OWNED_QUOTE_MIN) {
			outcome.gate = "source ownership unclear";
			return undefined;
		}
		if (optionGroup && index === 0) {
			let opening: Event = {
				id: stableId(channelId, message.id, 0, "thread.opened"),
				type: "thread.opened",
				threadId: optionGroup,
				observedThreadVersion: 0,
				origin: message.author.kind === "agent" ? "planner" : "classifier",
				actor: message.author.kind === "agent" ? { kind: "agent" } : { kind: "classifier" },
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
				working = applyInference(working, opening, message);
				events.push(opening);
				outcome.eventIds.push(opening.id);
			} catch {
				optionGroup = undefined;
				outcome.status = "review";
				outcome.gate = "multi-option question could not be opened";
				return undefined;
			}
		}
		if (optionGroup) {
			let label = optionLabels[index]!;
			if (seenOptionLabels.has(label)) {
				outcome.gate = "duplicate option in new question";
				return undefined;
			}
			seenOptionLabels.add(label);
		}
		return { index, candidate, outcome };
	} finally {
		context.working = working;
		context.candidateRun!.optionGroup = optionGroup;
	}
}
