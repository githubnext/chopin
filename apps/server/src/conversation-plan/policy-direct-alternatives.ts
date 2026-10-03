import type { ConversationPlan } from "@chopin/protocol";
import { applyInference } from "./domain";
import type { PolicyContext } from "./policy-context";
import { stableId } from "./policy-identity";
import type { Event, PolicyResult } from "./policy-types";

export function directAlternatives(
	context: PolicyContext,
	directQuestion: boolean,
): PolicyResult | undefined {
	let { input, channelId, message, events, reviews, outcomes } = context;
	let { directBounds } = context.facts!;
	let quotedOption = context.quotedOption!;
	let working = context.working;
	// Retain prior successful inference even when a later option rejects or throws.
	try {
		if (directQuestion && directBounds) {
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
				working = applyInference(working, opening, message);
			} catch {
				return { events, candidates: reviews, outcomes, policyGate: "direct question rejected" };
			}
			let directEvents: Event[] = [opening];
			let directOutcomes: PolicyResult["outcomes"] = [];
			for (let [index, candidate] of input.candidates.entries()) {
				let added = quotedOption(candidate, index, threadId, working);
				try {
					working = applyInference(working, added, message);
				} catch {
					return {
						events: [],
						candidates: reviews,
						outcomes: input.candidates.map(item => ({
							start: item.start,
							end: item.end,
							status: "review",
							gate: "direct option rejected",
							eventIds: [],
						})),
						policyGate: "direct option rejected",
					};
				}
				directEvents.push(added);
				directOutcomes.push({
					start: candidate.start,
					end: candidate.end,
					status: "accepted",
					gate: "accepted",
					eventIds: index === 0 ? [opening.id, added.id] : [added.id],
					targetId: threadId,
				});
			}
			return {
				events: directEvents,
				selectedTarget: threadId,
				candidates: reviews,
				outcomes: directOutcomes,
				policyGate: "direct alternatives accepted",
			};
		}
	} finally {
		context.working = working;
	}
}
