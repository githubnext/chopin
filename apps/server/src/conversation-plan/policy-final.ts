import type { ConversationPlan } from "@chopin/protocol";
import { applyInference } from "./domain";
import type { PolicyContext } from "./policy-context";
import { OWNED_QUOTE_MIN } from "./policy-cues";
import { stableId } from "./policy-identity";
import { noul, roleChoice } from "./policy-scoring";
import type { Event, PolicyResult } from "./policy-types";

/** Complete only after the original loop exits; fallback validation retains working unchanged. */
export function finishPolicy(context: PolicyContext): PolicyResult {
	let {
		input,
		channelId,
		message,
		first,
		events,
		reviews,
		outcomes,
		working,
		selectedTarget,
		directQuestion,
	} = context;
	if (directQuestion && !events.length) {
		let ownedQuestion = input.candidates.findIndex((candidate, index) =>
			noul(first, `c${index}_owned_unretracted`) >= OWNED_QUOTE_MIN
			&& roleChoice(candidate.answers, first) === "question"
		);
		if (ownedQuestion >= 0) {
			let threadId = `thread:${stableId(channelId, message.id, 0, "thread").slice(11)}`;
			let opening: Event = {
				id: stableId(channelId, message.id, 0, "thread.opened"),
				type: "thread.opened",
				threadId,
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
				applyInference(working, opening, message);
				events.push(opening);
				outcomes[ownedQuestion]!.eventIds.push(opening.id);
				outcomes[ownedQuestion]!.status = "accepted";
				outcomes[ownedQuestion]!.gate = "accepted";
			} catch {
				outcomes[ownedQuestion]!.status = "review";
				outcomes[ownedQuestion]!.gate = "question could not be opened";
			}
		}
	}
	let policyGate = outcomes.length
		? outcomes.map((outcome, index) => `${index}:${outcome.gate}`).join("; ").slice(0, 300)
		: "no source candidates";
	return { events, selectedTarget, candidates: reviews, outcomes, policyGate };
}
