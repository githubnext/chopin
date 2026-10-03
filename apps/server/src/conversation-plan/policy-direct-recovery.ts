import type { ConversationPlan } from "@chopin/protocol";
import { applyInference } from "./domain";
import type { DirectFacts, PolicyContext } from "./policy-context";
import { optionIdFor, stableId } from "./policy-identity";
import { choice } from "./policy-scoring";
import type { Event, PolicyResult, State } from "./policy-types";
import type { QuoteCandidate } from "./quotes";

export function createQuotedOption(context: PolicyContext) {
	let { channelId, message } = context;
	let quotedOption = (
		candidate: QuoteCandidate,
		index: number,
		threadId: string,
		state: State,
	): Event => ({
		id: stableId(channelId, message.id, index, "option.added"),
		type: "option.added",
		threadId,
		observedThreadVersion: state.threads.find(item => item.id === threadId)?.version ?? 0,
		origin: message.author.kind === "agent" ? "planner" : "classifier",
		actor: message.author.kind === "agent" ? { kind: "agent" } : { kind: "classifier" },
		at: message.ts,
		source: {
			messageId: message.id,
			author: message.author as ConversationPlan.SourceAuthor,
			quote: candidate.quote,
			start: candidate.start,
			end: candidate.end,
			role: "option",
		},
		contribution: {
			id: optionIdFor(channelId, message.id, index, message.ts),
			text: candidate.quote,
			authoring: "quoted",
			targetId: threadId,
		},
	});

	return quotedOption;
}

export function directRecovery(
	context: PolicyContext,
	facts: DirectFacts,
	quotedOption: ReturnType<typeof createQuotedOption>,
): PolicyResult | undefined {
	let { input, message, first, events, reviews } = context;
	let { exactDirectAlternatives, matchingThreads, directBounds, optionLabels } = facts;
	if (exactDirectAlternatives && matchingThreads.length) {
		let thread = matchingThreads.length === 1 ? matchingThreads[0] : undefined;
		let existing = new Set(
			thread?.contributions.filter(item => item.kind === "option")
				.map(item => item.text.trim().replace(/\s+/g, " ").toLowerCase()),
		);
		let staged = input.state;
		let additions: Event[] = [];
		let recoveryOutcomes: PolicyResult["outcomes"] = [];
		let target = choice(first, "thread_target");
		if (
			thread && directBounds && (target === thread.id || target === "new")
			&& choice(first, "act") === "question"
		) {
			for (let [index, candidate] of input.candidates.entries()) {
				let label = optionLabels[index]!;
				if (existing.has(label)) {
					recoveryOutcomes.push({
						start: candidate.start,
						end: candidate.end,
						status: "ignored",
						gate: "option already exists",
						eventIds: [],
					});
					continue;
				}
				let added = quotedOption(candidate, index, thread.id, staged);
				try {
					staged = applyInference(staged, added, message);
				} catch {
					return {
						events: [],
						candidates: reviews,
						outcomes: input.candidates.map(item => ({
							start: item.start,
							end: item.end,
							status: "review",
							gate: "direct option recovery rejected",
							eventIds: [],
						})),
						policyGate: "direct option recovery rejected",
					};
				}
				existing.add(label);
				additions.push(added);
				recoveryOutcomes.push({
					start: candidate.start,
					end: candidate.end,
					status: "accepted",
					gate: "accepted",
					eventIds: [added.id],
					targetId: thread.id,
				});
			}
			return {
				events: additions,
				selectedTarget: thread.id,
				candidates: reviews,
				outcomes: recoveryOutcomes,
				policyGate: additions.length ? "direct options recovered" : "question already complete",
			};
		}
		return {
			events,
			candidates: reviews,
			outcomes: input.candidates.map(candidate => ({
				start: candidate.start,
				end: candidate.end,
				status: "ignored",
				gate: "question recovery unclear",
				eventIds: [],
			})),
			policyGate: "question recovery unclear",
		};
	}
}
