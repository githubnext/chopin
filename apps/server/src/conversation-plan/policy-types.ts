import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { JevAnswer } from "./jev";
import type { QuoteCandidate } from "./quotes";
import type { LinkedCardOptions } from "./questions";

export type Event = ConversationPlan.Event;
export type State = ConversationPlan.State;
export type CandidateJudgment = QuoteCandidate & { answers: Record<string, JevAnswer> };
export type PolicyInput = {
	channelId: string;
	message: Chat.Entry;
	state: State;
	linkedCards?: LinkedCardOptions;
	first: Record<string, JevAnswer>;
	candidates: CandidateJudgment[];
};
export type PolicyResult = {
	events: Event[];
	selectedTarget?: string;
	candidates: Array<{ id: string; kind: "resolution" | "reopening"; targetId?: string }>;
	outcomes: ConversationPlan.CandidateOutcome[];
	policyGate: string;
};
