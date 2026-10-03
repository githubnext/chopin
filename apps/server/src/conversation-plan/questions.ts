import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { JevRequest } from "./jev";
import type { QuoteCandidate } from "./quotes";
import type { LinkedCardOptions } from "./question-shared";
import { buildTargetingRequest } from "./question-targeting";

export { buildResearchOfferRequest } from "./question-research";
export { hasWithdrawalCue, QUESTION_SET_VERSION } from "./question-shared";
export type { LinkedCardOptions } from "./question-shared";
export { buildTargetingRequest } from "./question-targeting";
export { buildTriageRequest, triageQuestions } from "./question-triage";

/** Keep one candidate's target questions free of later clauses in the same message. */
export function buildCandidateTargetingRequest(
	message: Chat.Entry,
	recent: readonly Chat.Entry[],
	threads: readonly ConversationPlan.Thread[],
	candidates: readonly QuoteCandidate[],
	index: number,
	events: readonly ConversationPlan.Event[] = [],
	linkedCards: LinkedCardOptions = new Map(),
): JevRequest {
	return buildTargetingRequest(message, recent, threads, candidates, index, events, linkedCards);
}
