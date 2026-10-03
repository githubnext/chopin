import type { ConversationPlan } from "@chopin/protocol";
import type { CandidateEntry } from "./policy-candidate-entry";
import type { PolicyContext } from "./policy-context";
import { stableId } from "./policy-identity";
import type { State } from "./policy-types";

/** Bind readWorking to the active handler's local working, never a finished handler or snapshot. */
export function createCandidateFactories(
	context: PolicyContext,
	entry: CandidateEntry,
	readWorking: () => State,
) {
	let { channelId, message } = context;
	let { index, candidate } = entry;
	let source = (sourceRole: ConversationPlan.SourceRole): ConversationPlan.SourceRef => ({
		messageId: message.id,
		author: message.author as ConversationPlan.SourceAuthor,
		quote: candidate.quote,
		start: candidate.start,
		end: candidate.end,
		role: sourceRole,
	});
	return {
		source,
		base: (threadId: string, type: string): ConversationPlan.EventBase => {
			let working = readWorking();
			let base = (threadId: string, type: string): ConversationPlan.EventBase => ({
				id: stableId(channelId, message.id, index, type),
				threadId,
				observedThreadVersion: working.threads.find((item) => item.id === threadId)?.version ?? 0,
				origin: message.author.kind === "agent" ? "planner" : "classifier",
				actor: message.author.kind === "agent" ? { kind: "agent" } : { kind: "classifier" },
				at: message.ts,
			});
			return base(threadId, type);
		},
	};
}
